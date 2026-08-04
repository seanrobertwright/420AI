import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { IngestBatch } from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import { machines, outcomeLabels, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import type { OutcomeLabelRow } from "./outcome-labels.js";
import {
  createOutcomeLabel,
  deleteOutcomeLabel,
  getOutcomeLabel,
  listOutcomeLabelRevisions,
  listOutcomeLabels,
  updateOutcomeLabel,
  OutcomeLabelError,
} from "./outcome-labels.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M16 16.1 — THE SLICE'S REPOSITORY-LAYER PROOF. A TWO-ROLE suite.
 *
 * CLAUDE.md's rule applies verbatim because this slice adds tenant tables: `bypassed ≠ enforced`.
 * Every other `*.int.test.ts` in this repo connects as the OWNER, which has `rolbypassrls`, and
 * against that role RLS is INERT — an owner-only suite would report green while enforcing nothing.
 * So:
 *
 *   - `owner` (DATABASE_URL_TEST)      — setup only: TRUNCATE (requires ownership) and seeding,
 *                                        plus the "did it REALLY get deleted?" counts, which must
 *                                        see past any policy to be worth making. Never used to
 *                                        assert an isolation property.
 *   - `appRole` (DATABASE_URL_TEST_APP) — EVERY isolation and behaviour assertion. Non-owner, no
 *                                        bypass.
 *
 * Test 1 (role identity) is why the rest mean anything: point the "app" handle at the owner URL by
 * mistake and every isolation test below still passes, while proving nothing.
 *
 * THIS IS THE LAYER WHERE DROPPING A POLICY MUST TURN THE FILE RED. The 15.3 measurement is the
 * reason both layers exist: an HTTP suite validates the PRIMARY defence (15.2's explicit `orgId`
 * predicates) and stays green under a wide-open policy, because those predicates scope the reads on
 * their own. The backstop proof has to live here.
 */

/** A minimal batch so a session EXISTS — the HTTP route's guard needs it; the repository does not. */
function batch(tag: string, sessionId: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ from: tag }),
      },
    ],
    events: [
      {
        fingerprint: `${tag}-fp-1`,
        sourceConnector: "claude-code",
        parserVersion: "1.0.0",
        rawRecordId: `raw-${tag}`,
        eventIndex: 0,
        eventType: "message.user",
        sessionId,
        ts: "2026-08-01T00:00:00.000Z",
      },
    ],
  };
}

/**
 * Flatten an error and its `cause` chain into one searchable string. Drizzle wraps every driver
 * error in a `DrizzleQueryError` whose `message` is the SQL text and hangs the real Postgres error
 * off `.cause`, so a plain `.rejects.toThrow(/row-level security policy/)` FAILS even when the
 * policy fired exactly as intended. Asserting the SPECIFIC Postgres error is the whole point of a
 * negative test: a NOT NULL or FK violation would also throw, and would mean the policy never ran.
 *
 * Copied from `rls.int.test.ts` rather than imported — these are per-file helpers there too.
 */
function errorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 10; depth++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** Assert a promise rejects with a Postgres row-level-security violation, at any cause depth. */
async function expectRlsRejection(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected an RLS rejection, but the statement SUCCEEDED").toBeDefined();
  expect(errorChain(thrown)).toMatch(/row-level security policy/i);
}

/** The role these `withOrg` calls run under. Tenancy assertions must not trip the 0016 policies. */
const WRITE_ROLE = "member";

/** The same connector session id in BOTH orgs — globally scoped, so a collision is legal. */
const SHARED_SESSION = "COLLIDING-SESSION-16-1";

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.1 outcome labels (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userA2: string;
  let userB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE outcome_label_revisions, outcome_labels, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "a2@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userA2 = seeded.find((u) => u.email === "a2@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    // `userA2` is a SECOND identity inside org A, for the author-only tests. Its own personal org
    // is irrelevant here — what matters is that it can hold a label in org A that `userA` did not
    // write. The repository takes `authorUserId` as a parameter, so no membership seeding is
    // needed at this layer (the HTTP suite is where memberships matter).
    const [mA] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await owner.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });
    await ingestBatch(owner.db, mA!.id, batch("A", SHARED_SESSION));
    await ingestBatch(owner.db, mB!.id, batch("B", SHARED_SESSION));
  });

  /** Create a `labeled` row for org A / userA, through the app role. */
  async function seedLabelA(sessionId = SHARED_SESSION, authorUserId = userA) {
    return withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId,
        authorUserId,
        status: "labeled",
        taskType: "feature",
        intent: "ship the label API",
        outcome: "shipped",
        qualityRating: 4,
        primaryFriction: "none",
        confidence: "high",
      }),
    );
  }

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");

    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);

    const who = await appRole.db.execute<{ u: string }>(sql`select current_user as u`);
    expect(who.rows[0]!.u).toBe("420ai_app");
  });

  // 2 ── FAILS CLOSED. An unset context is 0 rows — not an error, not data.
  it("with NO org context both tables read 0 rows (and do not error)", async () => {
    await seedLabelA();

    const labels = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_labels`,
    );
    const revisions = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_label_revisions`,
    );
    expect(labels.rows[0]!.n).toBe(0);
    expect(revisions.rows[0]!.n).toBe(0);

    // The owner sees the row, so "0" above is the policy at work rather than an empty table.
    const asOwner = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_labels`,
    );
    expect(asOwner.rows[0]!.n).toBe(1);
  });

  /**
   * 2b ── THE WRONG-CONTEXT CASE, which is the one that actually discriminates.
   *
   * Test 2 above proves an UNSET context reads zero rows. That is a real property, but it is not
   * the leak scenario — the leak scenario is "org A's context can see org B's row". Every other
   * test in this file goes through a repository function carrying an explicit `eq(orgId)`
   * predicate, so all of them stay green if `outcome_labels_org_isolation` is replaced with
   * `USING (true)`: measured during 16.1, only 2 of 16 turned red. That is 15.2's primary defence
   * working, and it is exactly why the backstop needs its OWN assertion.
   *
   * So this reads the tables with a PREDICATE-FREE raw select under org A's context. Nothing but
   * the policy can scope it, which makes it the test that fails when the policy is loosened.
   */
  it("under org A's context a PREDICATE-FREE read sees only org A's rows", async () => {
    await seedLabelA();
    await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgB, {
        sessionId: SHARED_SESSION,
        authorUserId: userB,
        status: "skipped",
      }),
    );
    // Both orgs hold a label for the SAME session id — the owner handle sees both.
    const total = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_labels`,
    );
    expect(total.rows[0]!.n).toBe(2);

    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      const labels = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from outcome_labels`,
      );
      const revisions = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from outcome_label_revisions`,
      );
      expect(labels.rows[0]!.n, "org A must not see org B's label").toBe(1);
      expect(revisions.rows[0]!.n, "org A must not see org B's revisions").toBe(1);
    });
  });

  // 2c ── The 15.4 role backstop on UPDATE. INSERT and DELETE are covered by test 12; UPDATE is the
  //       third RESTRICTIVE policy and the one protecting an EXISTING judgement from a read-only
  //       account whose route gate someone later removes.
  it("a viewer context cannot UPDATE an existing label (loud, via WITH CHECK)", async () => {
    await seedLabelA();
    await expectRlsRejection(
      withOrg(appRole.db, orgA, "viewer", (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 1 }),
      ),
    );
    // The judgement is untouched — counted on the owner handle so no policy can mask it.
    const row = await owner.db.execute<{ revision: number; quality_rating: number }>(
      sql`select revision, quality_rating from outcome_labels`,
    );
    expect(row.rows[0]!.revision).toBe(1);
    expect(row.rows[0]!.quality_rating).toBe(4);
  });

  // 3 ── D-16.1-3. THE 15.1/15.2 BUG SHAPE: two tenants holding the SAME connector session id.
  it("two orgs label the SAME session_id independently and never see each other's", async () => {
    await seedLabelA();
    await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgB, {
        sessionId: SHARED_SESSION,
        authorUserId: userB,
        status: "labeled",
        taskType: "bug_fix",
        intent: "ORG-B-INTENT",
        outcome: "blocked",
        qualityRating: 2,
        primaryFriction: "context",
      }),
    );

    const a = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    const b = await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgB, SHARED_SESSION),
    );
    expect(a!.intent).toBe("ship the label API");
    expect(b!.intent).toBe("ORG-B-INTENT");
    expect(a!.id).not.toBe(b!.id);

    // A unique index on `(session_id)` alone would have made the second create fail outright; a
    // missing org predicate would have made these two reads return the same row.
    const listA = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => listOutcomeLabels(tx, orgA));
    expect(listA).toHaveLength(1);
    expect(listA[0]!.intent).toBe("ship the label API");
  });

  // 4 ── D-16.1-3. A second label for one (org, session) is a CONFLICT, never a silent overwrite.
  it("a second create for the same (org, session) throws already_labeled", async () => {
    await seedLabelA();
    let thrown: unknown;
    try {
      await seedLabelA(SHARED_SESSION, userA2);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutcomeLabelError);
    expect((thrown as OutcomeLabelError).reason).toBe("already_labeled");

    // And the ORIGINAL survived — a conflict must not half-apply the loser's values.
    const row = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    expect(row!.authorUserId).toBe(userA);
  });

  // 5 ── D-16.1-2. A SKIP IS A ROW, with all six §4.3 fields NULL.
  it("a skipped label persists with every §4.3 field null", async () => {
    const created = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: SHARED_SESSION,
        authorUserId: userA,
        status: "skipped",
      }),
    );
    expect(created.status).toBe("skipped");
    for (const f of [
      created.taskType,
      created.intent,
      created.outcome,
      created.qualityRating,
      created.primaryFriction,
      created.followUpCommitOrPr,
      created.confidence,
    ]) {
      expect(f).toBeNull();
    }
    // The row is what makes "do not nag repeatedly" implementable: 16.2 asks the archive whether it
    // already offered, and a skip that left no trace could not answer.
    const found = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    expect(found!.status).toBe("skipped");
  });

  // 6 ── D-16.1-1. THE HISTORY IS A RECORD, NOT A COUNTER — v1 keeps the ORIGINAL values.
  it("create + two patches yield revisions 1,2,3 with v1 holding the original rating", async () => {
    await seedLabelA();
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 2 }),
    );
    const final = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 5, outcome: "blocked" }),
    );
    expect(final.revision).toBe(3);
    expect(final.qualityRating).toBe(5);
    // An unpatched field is LEFT ALONE rather than cleared.
    expect(final.intent).toBe("ship the label API");

    const revisions = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabelRevisions(tx, orgA, SHARED_SESSION),
    );
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    // THE POINT OF THE WHOLE TABLE: a rating revised 4 → 2 → 5 a week later is HINDSIGHT, and a
    // counter could not tell 16.4 that it happened. v1 still says 4.
    expect(revisions[0]!.qualityRating).toBe(4);
    expect(revisions[0]!.outcome).toBe("shipped");
    expect(revisions[1]!.qualityRating).toBe(2);
    expect(revisions[2]!.qualityRating).toBe(5);
    expect(revisions[2]!.outcome).toBe("blocked");
  });

  /**
   * 6b ── THE `labeled`/`skipped` INVARIANT SURVIVES AN EDIT, in BOTH directions.
   *
   * Both halves are REGRESSION tests: 16.1's code review found the invariant enforced only on the
   * create path, and measured both failures against a live database. They are asserted here rather
   * than at the HTTP layer because the repository is where the guard lives — and because a future
   * caller (a script, 16.4's backfill) reaches it without going through a route.
   */
  it("patching a labeled row to skipped CLEARS the judgement, and keeps it readable in history", async () => {
    await seedLabelA();
    const skipped = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { status: "skipped" }),
    );
    expect(skipped.status).toBe("skipped");
    // Before the fix these came back as "shipped" / 4 — a skip carrying a full judgement, which is
    // contradictory rather than merely stale, and which 16.4's per-outcome histogram would count.
    for (const f of [
      skipped.taskType,
      skipped.intent,
      skipped.outcome,
      skipped.qualityRating,
      skipped.primaryFriction,
      skipped.confidence,
    ]) {
      expect(f).toBeNull();
    }
    // THE CLEAR IS A RETRACTION, NOT AN ERASURE — that is what makes the data loss above safe.
    // v1 still holds what the operator originally said.
    const revisions = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabelRevisions(tx, orgA, SHARED_SESSION),
    );
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[0]!.outcome).toBe("shipped");
    expect(revisions[0]!.qualityRating).toBe(4);
    expect(revisions[1]!.status).toBe("skipped");
    expect(revisions[1]!.outcome).toBeNull();
  });

  it("patching a skipped row to labeled WITHOUT a judgement is refused as incomplete_label", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: SHARED_SESSION,
        authorUserId: userA,
        status: "skipped",
      }),
    );
    let thrown: unknown;
    try {
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { status: "labeled" }),
      );
    } catch (e) {
      thrown = e;
    }
    // Before the fix this returned 200 with all five fields NULL — a row in the NUMERATOR of
    // "sessions I judged" containing nothing a human decided.
    expect(thrown).toBeInstanceOf(OutcomeLabelError);
    expect((thrown as OutcomeLabelError).reason).toBe("incomplete_label");
    // The message NAMES the missing fields, so the surface can point at them.
    expect((thrown as OutcomeLabelError).message).toContain("outcome");
    // And nothing was half-applied: the row is still a skip at revision 1.
    const row = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    expect(row!.status).toBe("skipped");
    expect(row!.revision).toBe(1);
  });

  /**
   * REGRESSION (prp-review): patching FIELDS onto a still-`skipped` row must not silently blank it.
   *
   * The first version of the skip-clearing fix keyed on the EFFECTIVE status
   * (`patch.status ?? existing.status`), so a `PATCH {"qualityRating": 4}` against a row that was
   * already `skipped` took the blanking branch: the supplied values were discarded, the row was
   * rewritten all-NULL, `revision` bumped, and a snapshot identical to its predecessor was
   * appended — all behind a 200. `minProperties: 1` catches an EMPTY body and is blind to a
   * semantically-empty one, so nothing else would have caught it.
   */
  it("patching fields onto a still-skipped row is refused, not silently dropped", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: SHARED_SESSION,
        authorUserId: userA,
        status: "skipped",
      }),
    );
    let thrown: unknown;
    try {
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, {
          qualityRating: 4,
          outcome: "shipped",
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutcomeLabelError);
    expect((thrown as OutcomeLabelError).reason).toBe("incomplete_label");
    // The message names what the caller tried to set, so the surface can explain the refusal.
    expect((thrown as OutcomeLabelError).message).toContain("qualityRating");

    // Nothing was written: still revision 1, and no second snapshot.
    const row = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    expect(row!.revision).toBe(1);
    const revisions = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabelRevisions(tx, orgA, SHARED_SESSION),
    );
    expect(revisions).toHaveLength(1);
  });

  it("a skip CAN be upgraded to a labeled row when the judgement comes with it", async () => {
    // The positive control for the test above — the transition §4.3 actually wants ("I went back
    // and judged it") must still work, or the guard has broken the feature it protects.
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: SHARED_SESSION,
        authorUserId: userA,
        status: "skipped",
      }),
    );
    const upgraded = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, {
        status: "labeled",
        taskType: "bug_fix",
        intent: "went back and judged it",
        outcome: "useful_partial",
        qualityRating: 3,
        primaryFriction: "context",
      }),
    );
    expect(upgraded.status).toBe("labeled");
    expect(upgraded.outcome).toBe("useful_partial");
    expect(upgraded.revision).toBe(2);
  });

  it("clearing a REQUIRED field on a labeled row is refused; the two OPTIONAL ones clear fine", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: SHARED_SESSION,
        authorUserId: userA,
        status: "labeled",
        taskType: "feature",
        intent: "keep me",
        outcome: "shipped",
        qualityRating: 4,
        primaryFriction: "none",
        followUpCommitOrPr: "abc123",
        confidence: "high",
      }),
    );
    // `outcome: null` on a row that still says `labeled` is exactly the incoherent state the guard
    // exists to refuse — the HTTP schema also rejects it, but the repository must not depend on that.
    await expect(
      withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { outcome: null }),
      ),
    ).rejects.toThrow(/labeled outcome requires/);

    // The two §4.3 marks OPTIONAL clear normally — this is the capability the review found
    // documented but unreachable from HTTP, so it is pinned at both layers.
    const cleared = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, {
        followUpCommitOrPr: null,
        confidence: null,
      }),
    );
    expect(cleared.followUpCommitOrPr).toBeNull();
    expect(cleared.confidence).toBeNull();
    expect(cleared.status).toBe("labeled");
    expect(cleared.outcome).toBe("shipped");
  });

  // 7 ── D-16.1-4. AUTHOR-ONLY EDIT. Rewriting someone else's answer is falsifying evidence.
  it("a different user patching another's label throws not_author, and changes nothing", async () => {
    await seedLabelA();
    let thrown: unknown;
    try {
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA2, { qualityRating: 1 }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutcomeLabelError);
    expect((thrown as OutcomeLabelError).reason).toBe("not_author");

    const row = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      getOutcomeLabel(tx, orgA, SHARED_SESSION),
    );
    expect(row!.qualityRating).toBe(4);
    expect(row!.revision).toBe(1);
  });

  // 8 ── `not_found` is a missing subject, and another org's label is missing TO YOU.
  it("patching a nonexistent label — or another org's — throws not_found", async () => {
    await seedLabelA();
    for (const [org, user] of [
      [orgA, userA],
      [orgB, userB],
    ] as const) {
      let thrown: unknown;
      try {
        await withOrg(appRole.db, org, WRITE_ROLE, (tx) =>
          updateOutcomeLabel(tx, org, org === orgA ? "NO-SUCH-SESSION" : SHARED_SESSION, user, {
            qualityRating: 1,
          }),
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(OutcomeLabelError);
      expect((thrown as OutcomeLabelError).reason).toBe("not_found");
    }
  });

  // 9 ── D-16.1-6. THE ARCHIVE POLICY, asserted end to end.
  it("delete removes the label AND every revision, and leaves events/raw records untouched", async () => {
    await seedLabelA();
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 5 }),
    );

    // Counted on the OWNER handle, before and after: this is a "did it really go?" question, and a
    // count taken through a policy could report 0 for the wrong reason.
    const countLabels = async () =>
      (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from outcome_labels`))
        .rows[0]!.n;
    const countRevisions = async () =>
      (
        await owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from outcome_label_revisions`,
        )
      ).rows[0]!.n;
    const countEvents = async () =>
      (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from events`)).rows[0]!
        .n;
    const countRaw = async () =>
      (
        await owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from raw_source_records`,
        )
      ).rows[0]!.n;

    expect(await countLabels()).toBe(1);
    expect(await countRevisions()).toBe(2);
    const eventsBefore = await countEvents();
    const rawBefore = await countRaw();

    const deleted = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      deleteOutcomeLabel(tx, orgA, SHARED_SESSION, { requesterUserId: userA, force: false }),
    );
    expect(deleted).toBe(true);
    expect(await countLabels()).toBe(0);
    expect(await countRevisions()).toBe(0);

    // §7 P0.2's CENTRAL CLAIM — "never a mutation of a raw record" — asserted rather than assumed.
    // Both orgs' events and raw records are exactly as they were.
    expect(await countEvents()).toBe(eventsBefore);
    expect(await countRaw()).toBe(rawBefore);
  });

  // 10 ── D-16.1-4. DELETE is author-OR-admin: a non-author without `force` gets a refusal.
  it("a non-author delete returns false without force, and true with it", async () => {
    await seedLabelA();
    const refused = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      deleteOutcomeLabel(tx, orgA, SHARED_SESSION, { requesterUserId: userA2, force: false }),
    );
    expect(refused).toBe(false);
    // False is a REFUSAL, not a no-op report: the row must still be there.
    expect(
      await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        getOutcomeLabel(tx, orgA, SHARED_SESSION),
      ),
    ).toBeDefined();

    const forced = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      deleteOutcomeLabel(tx, orgA, SHARED_SESSION, { requesterUserId: userA2, force: true }),
    );
    expect(forced).toBe(true);
  });

  // 11 ── Deleting a label another org owns finds nothing — and does not touch theirs.
  it("org B cannot delete org A's label for the shared session id", async () => {
    await seedLabelA();
    const deleted = await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      deleteOutcomeLabel(tx, orgB, SHARED_SESSION, { requesterUserId: userB, force: true }),
    );
    expect(deleted).toBe(false);
    const stillThere = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_labels`,
    );
    expect(stillThere.rows[0]!.n).toBe(1);
  });

  // 12 ── M15 15.4 BACKSTOP, both halves — and they behave DIFFERENTLY on purpose.
  it("a viewer context is refused LOUDLY on INSERT and SILENTLY on DELETE", async () => {
    // INSERT carries its test in `WITH CHECK`, so the refusal is a real Postgres error.
    await expectRlsRejection(
      withOrg(appRole.db, orgA, "viewer", (tx) =>
        createOutcomeLabel(tx, orgA, {
          sessionId: SHARED_SESSION,
          authorUserId: userA,
          status: "skipped",
        }),
      ),
    );

    await seedLabelA();

    // DELETE has NO `WITH CHECK` in Postgres — the test must live in `USING`, so a blocked delete
    // is an unavoidable, SILENT `DELETE 0`. ASSERTED EXPLICITLY so nobody later "fixes" this into
    // an expectation the database cannot meet (CLAUDE.md M15 15.4). The consequence is a design
    // constraint, not a bug: the ROUTE gate is the only layer that can be loud for deletes, which
    // is why `routes/outcome-labels.ts` gates DELETE at `member` before the query ever runs.
    const result = await withOrg(appRole.db, orgA, "viewer", (tx) =>
      deleteOutcomeLabel(tx, orgA, SHARED_SESSION, { requesterUserId: userA, force: true }),
    );
    expect(result).toBe(false); // silent, no throw
    const survived = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_labels`,
    );
    expect(survived.rows[0]!.n).toBe(1);
    // AND THE HISTORY SURVIVED TOO. `deleteOutcomeLabel` deletes the revisions FIRST, so a policy
    // that blocked only the parent would leave the label in place with its history destroyed — a
    // silent loss on the one table whose purpose is auditability. Both tables carry byte-identical
    // RESTRICTIVE policies precisely so this pair is 0/0; assert the child explicitly, or the day
    // they diverge this test stays green while the damage lands.
    const revisionsSurvived = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_label_revisions`,
    );
    expect(revisionsSurvived.rows[0]!.n).toBe(1);
  });

  // 13 ── A cross-org INSERT is LOUD, with no explicit WITH CHECK on the policy: a `FOR ALL`
  //       policy applies its `USING` expression as the INSERT `WITH CHECK`. This is why migration
  //       0024 deliberately omits one — adding it would make these tables differ from the other 13.
  it("inserting org B's org_id under an org A context is rejected by the policy", async () => {
    await expectRlsRejection(
      withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        tx.insert(outcomeLabels).values({
          orgId: orgB,
          sessionId: "SNEAKY",
          authorUserId: userB,
          status: "skipped",
        }),
      ),
    );
  });

  // 14 ── The list read is org-scoped, filterable and ordered newest-edit-first.
  it("listOutcomeLabels filters by status and orders by updatedAt desc", async () => {
    await seedLabelA("session-1");
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgA, {
        sessionId: "session-2",
        authorUserId: userA,
        status: "skipped",
      }),
    );

    const all = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => listOutcomeLabels(tx, orgA));
    expect(all).toHaveLength(2);
    // `session-2` was written second, so it sorts first.
    expect(all[0]!.sessionId).toBe("session-2");

    const skipped = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabels(tx, orgA, { status: "skipped" }),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.sessionId).toBe("session-2");

    const paged = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabels(tx, orgA, { limit: 1, offset: 1 }),
    );
    expect(paged).toHaveLength(1);
    expect(paged[0]!.sessionId).toBe("session-1");
  });

  // 15 ── A row that reaches `reply.send()` must not carry the tenant id (the 15.1 lesson).
  it("no repository row exposes org_id", async () => {
    const created = await seedLabelA();
    expect(created).not.toHaveProperty("orgId");
    const listed = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) => listOutcomeLabels(tx, orgA));
    expect(listed[0]).not.toHaveProperty("orgId");
    const revisions = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      listOutcomeLabelRevisions(tx, orgA, SHARED_SESSION),
    );
    expect(revisions[0]).not.toHaveProperty("orgId");
    expect(revisions[0]).not.toHaveProperty("labelId");
  });

  /**
   * 16 ── CONCURRENCY, AT THE LAYER WHERE IT CAN ACTUALLY FAIL (M15 15.5).
   *
   * Two HAND-HELD transactions, not two HTTP requests. That distinction cost 15.5 more than the fix
   * it was testing: two concurrent requests serialise on their own at that granularity, so the test
   * passed identically with and without the lock — a green test advertising a guarantee nobody had
   * checked. Only holding both transactions open discriminates.
   *
   * The mechanism under test is the `FOR UPDATE` in `updateOutcomeLabel`. Without it, both
   * transactions read `revision = 1` and both write 2 — the second either overwrites the first's
   * merged state or trips the revisions unique index. With it, the second BLOCKS until the first
   * commits, then re-reads `revision = 2` and correctly writes 3.
   *
   * THE RELEASE IS IN A `finally`, AND THAT IS NOT BOILERPLATE — it was measured here. The first
   * version of this test released the held transaction only on the success path, so when its
   * assertion failed the transaction kept its pooled connection forever, `pool.end()` waited on the
   * live client, and vitest reported a 5 s TIMEOUT instead of the assertion that actually failed.
   * A real failure wearing a fake one, which is exactly the 15.5 lesson one level down.
   *
   * WAITING FOR THE LOCK TO BE TAKEN IS ALSO LOAD-BEARING. Launching transaction 2 immediately
   * after constructing transaction 1's promise is a RACE, not a serialisation test: the callback
   * runs only up to its first `await`, so transaction 2's `SELECT … FOR UPDATE` can reach the row
   * first, win the lock, and settle — making the discriminating assertion below fail for a reason
   * that has nothing to do with the code under test. `lockTaken` removes the race.
   */
  it("two concurrent patches serialise on the FOR UPDATE lock and produce contiguous revisions", async () => {
    await seedLabelA();

    const first = createDb(APP_URL!);
    let releaseFirst: () => void = () => {};
    // Hoisted so the `finally` can settle them — declared inside the `try` they would be out of
    // scope exactly where the cleanup needs them.
    let firstTx: Promise<unknown> = Promise.resolve();
    let secondTx: Promise<unknown> = Promise.resolve();
    try {
      // Transaction 1: patch, then HOLD the transaction open without committing.
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let signalLockTaken!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        signalLockTaken = resolve;
      });
      firstTx = first.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_org', ${orgA}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_role', ${WRITE_ROLE}, true)`);
        await updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 2 });
        signalLockTaken();
        await held;
      });
      await lockTaken;

      // Transaction 2 now races a lock that is DEFINITELY held. It must not settle.
      //
      // A `.catch` is attached AT CREATION, not later: if the discriminating assertion below
      // throws, this promise is never awaited, and an un-caught rejection would surface as an
      // UNHANDLED REJECTION instead of the assertion that actually failed — the same "real failure
      // wearing a fake one" this test's own header warns about, one level out. The `finally` then
      // settles both before ending the pool.
      let secondSettled = false;
      secondTx = withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        updateOutcomeLabel(tx, orgA, SHARED_SESSION, userA, { qualityRating: 3 }),
      ).then((r) => {
        secondSettled = true;
        return r;
      });
      secondTx.catch(() => {});

      await new Promise((r) => setTimeout(r, 400));
      // THE DISCRIMINATING ASSERTION. Remove `.for("update")` and this reads `true`.
      expect(secondSettled, "the second patch must block on the first's row lock").toBe(false);

      releaseFirst();
      await firstTx;
      // `secondTx` is hoisted as `Promise<unknown>` so the `finally` can settle it, so the row
      // shape is re-stated here rather than inferred.
      const second = (await secondTx) as OutcomeLabelRow;

      // The loser re-read the bumped revision after the lock released, so the history is
      // contiguous rather than two rows both claiming to be v2.
      expect(second.revision).toBe(3);
      const revisions = await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
        listOutcomeLabelRevisions(tx, orgA, SHARED_SESSION),
      );
      expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    } finally {
      // Unblock the held transaction FIRST — otherwise `pool.end()` waits on its live client and a
      // failed assertion above surfaces as a timeout instead of itself. Then let BOTH transactions
      // settle before ending the pool, so no in-flight query is torn down mid-statement.
      releaseFirst();
      await Promise.allSettled([firstTx, secondTx]);
      await first.pool.end();
    }
  }, 15_000);
});
