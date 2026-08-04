import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { ACTIVE_WINDOW_MS, LABEL_QUEUE_LOOKBACK_MS, type IngestBatch } from "@420ai/shared";
import { createDb, ingestBatch, withOrg } from "../index.js";
import { machines, users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { createOutcomeLabel } from "./outcome-labels.js";
import { labelQueue } from "./label-queue.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M16 16.2 — THE LABEL QUEUE'S REPOSITORY-LAYER PROOF. A TWO-ROLE suite, mirroring
 * `outcome-labels.int.test.ts` (16.1) exactly.
 *
 * CLAUDE.md's rule, verbatim: `bypassed ≠ enforced`. `DATABASE_URL_TEST` owns the tables and so has
 * `rolbypassrls` — against it RLS is INERT, and an owner-only suite reports green while enforcing
 * nothing. So the owner handle SEEDS (TRUNCATE requires ownership) and the app handle ASSERTS.
 *
 * ONE DELIBERATE EXCEPTION, and it is the most important test in the file: the cross-org negative
 * control (test 7) runs on the OWNER handle ON PURPOSE. It exists to prove the query's own
 * join-side `orgId` predicate, and running it under RLS would let the backstop mask a missing
 * predicate — the test would pass with the bug present. Measuring the primary defence requires
 * turning the backstop off.
 *
 * THE CLOCK IS FIXED AND INJECTED. Every window boundary below is derived from `NOW_MS` and every
 * seeded event timestamp is relative to it. A suite that used the wall clock would pass today and
 * fail in the 15th minute of some future run — the settle window is 15 minutes wide.
 */

/** A batch whose events carry explicit timestamps, so the window boundaries are testable. */
function batchAt(
  tag: string,
  sessionId: string,
  tsList: string[],
  model = "claude-opus-4",
): IngestBatch {
  return {
    records: [
      {
        sourceConnector: "claude-code",
        sessionId,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ from: tag }),
      },
    ],
    events: tsList.map((ts, i) => ({
      fingerprint: `${tag}-fp-${i}`,
      sourceConnector: "claude-code",
      parserVersion: "1.0.0",
      rawRecordId: `raw-${tag}`,
      eventIndex: i,
      eventType: "message.user",
      sessionId,
      ts,
      model,
    })),
  };
}

/** The role these `withOrg` calls run under. Must not trip the 0016 RESTRICTIVE role policies. */
const WRITE_ROLE = "member";

/** A FIXED clock. Everything below is relative to it — see the header. */
const NOW_MS = Date.parse("2026-08-01T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** The window arguments the ROUTE computes; the repository is clock-free. */
const OPTS = {
  settledBeforeIso: new Date(NOW_MS - ACTIVE_WINDOW_MS).toISOString(),
  sinceIso: new Date(NOW_MS - LABEL_QUEUE_LOOKBACK_MS).toISOString(),
};

const SETTLED = "settled-unlabeled";
const ACTIVE = "still-active";
const OLD = "aged-out";
const LABELED = "settled-labeled";
const SKIPPED = "settled-skipped";
const BOUNDARY = "exactly-on-the-settle-boundary";
/** The same connector session id in BOTH orgs — globally scoped, so a collision is legal. */
const SHARED_SESSION = "COLLIDING-SESSION-16-2";

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.2 label queue (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
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
    // The label tables lead the list: they carry FKs into `organizations`/`users`, and the
    // revisions table into `outcome_labels`.
    await owner.db.execute(
      sql`TRUNCATE outcome_label_revisions, outcome_labels, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    const [mA] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await owner.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });

    // Org A's sessions, one per window case. SETTLED carries TWO events so the fan-out test has
    // something to count.
    await ingestBatch(
      owner.db,
      mA!.id,
      batchAt("settled", SETTLED, [at(60 * MINUTE), at(50 * MINUTE)]),
    );
    await ingestBatch(owner.db, mA!.id, batchAt("active", ACTIVE, [at(5 * MINUTE)]));
    await ingestBatch(owner.db, mA!.id, batchAt("old", OLD, [at(20 * DAY)]));
    await ingestBatch(owner.db, mA!.id, batchAt("labeled", LABELED, [at(60 * MINUTE)]));
    await ingestBatch(owner.db, mA!.id, batchAt("skipped", SKIPPED, [at(60 * MINUTE)]));
    // Exactly ON the settle boundary: `max(ts) < settledBefore` is STRICT, so this one is still
    // "active" and must be ABSENT. The Live Monitor's own predicate is `max(ts) >= sinceIso`, so
    // the two windows meet here with neither an overlap nor a gap — that is the point of sharing
    // `ACTIVE_WINDOW_MS` (D-16.2-2).
    await ingestBatch(owner.db, mA!.id, batchAt("boundary", BOUNDARY, [OPTS.settledBeforeIso]));
    // The SAME session id in both orgs.
    await ingestBatch(owner.db, mA!.id, batchAt("sharedA", SHARED_SESSION, [at(60 * MINUTE)]));
    await ingestBatch(owner.db, mB!.id, batchAt("sharedB", SHARED_SESSION, [at(60 * MINUTE)]));
  });

  /** Session ids from a queue read, for set-style assertions. */
  const ids = (rows: { sessionId: string }[]): string[] => rows.map((r) => r.sessionId).sort();

  /** Read the queue as org A through the APP role, inside an org context. */
  const queueAsApp = (orgId = orgA) =>
    withOrg(appRole.db, orgId, WRITE_ROLE, (tx) => labelQueue(tx, orgId, OPTS));

  /** Write a label (or a skip) for org A through the app role. */
  async function labelA(sessionId: string, status: "labeled" | "skipped") {
    return withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      createOutcomeLabel(
        tx,
        orgA,
        status === "skipped"
          ? { sessionId, authorUserId: userA, status: "skipped" }
          : {
              sessionId,
              authorUserId: userA,
              status: "labeled",
              taskType: "feature",
              intent: "ship the label surfaces",
              outcome: "shipped",
              qualityRating: 4,
              primaryFriction: "none",
              confidence: "high",
            },
      ),
    );
  }

  // 1 ── ROLE IDENTITY. Without this the whole file is theatre (CLAUDE.md).
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

  // 2 ── The window predicates, all at once.
  it("returns only SETTLED, in-window, UNLABELED sessions", async () => {
    await labelA(LABELED, "labeled");
    await labelA(SKIPPED, "skipped");

    expect(ids(await queueAsApp())).toEqual([SHARED_SESSION, SETTLED].sort());
  });

  // 3 ── A judged session leaves.
  it("a LABELED session leaves the queue", async () => {
    expect(ids(await queueAsApp())).toContain(SETTLED);
    await labelA(SETTLED, "labeled");
    expect(ids(await queueAsApp())).not.toContain(SETTLED);
  });

  // 4 ── …and so does a declined one. THIS IS §4.3's "do not nag repeatedly", in full.
  it("a SKIPPED session leaves the queue permanently (the never-nag proof)", async () => {
    expect(ids(await queueAsApp())).toContain(SETTLED);
    await labelA(SETTLED, "skipped");
    // Nothing anywhere records "already asked" — D-16.1-2 made a skip a ROW, so the same
    // `count(labels.id) = 0` predicate that excludes a judgement excludes a declination.
    expect(ids(await queueAsApp())).not.toContain(SETTLED);
  });

  // 5 ── Still-active sessions are not offered. Asking a human to judge a session they are in the
  //      middle of is the fastest route to the milestone's Risk 3.
  it("a session with activity inside the settle window is ABSENT", async () => {
    expect(ids(await queueAsApp())).not.toContain(ACTIVE);
  });

  it("a session EXACTLY on the settle boundary is ABSENT (`<` is strict)", async () => {
    expect(ids(await queueAsApp())).not.toContain(BOUNDARY);
  });

  // 6 ── Aged out. Deliberately unreachable from the queue; `/labels` is how it gets labelled late.
  it("a session older than the lookback is ABSENT", async () => {
    expect(ids(await queueAsApp())).not.toContain(OLD);
  });

  // 7 ── THE NEGATIVE CONTROL, on the OWNER handle so it measures the PREDICATE and not RLS.
  //
  //      Drop `eq(outcomeLabels.orgId, orgId)` from the leftJoin in `label-queue.ts` and this test
  //      is the one that fails: org B's label on a session id org A also owns would suppress org
  //      A's queue row. That failure is SILENT in production — the operator's session simply never
  //      appears, so it never gets labelled, so 16.4's denominator is quietly wrong.
  it("a label written by ANOTHER org on a shared session id does not affect this org's queue", async () => {
    const before = ids(await labelQueue(owner.db, orgA, OPTS));
    expect(before).toContain(SHARED_SESSION);

    await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      createOutcomeLabel(tx, orgB, {
        sessionId: SHARED_SESSION,
        authorUserId: userB,
        status: "labeled",
        taskType: "bug_fix",
        intent: "org B's own judgement of its own session",
        outcome: "shipped",
        qualityRating: 5,
        primaryFriction: "none",
        confidence: "high",
      }),
    );

    // Org B's queue loses it (its own label); org A's does NOT.
    expect(ids(await labelQueue(owner.db, orgB, OPTS))).not.toContain(SHARED_SESSION);
    expect(ids(await labelQueue(owner.db, orgA, OPTS))).toContain(SHARED_SESSION);
  });

  // 8 ── The left join must not fan out. `outcome_labels` carries a unique (org_id, session_id), so
  //      it cannot — do not "fix" this with a `distinct` that would also break `count`.
  it("eventCount is the true event count (no left-join fan-out)", async () => {
    const row = (await queueAsApp()).find((r) => r.sessionId === SETTLED);
    expect(row?.eventCount).toBe(2);
    // …and the aggregate timestamps are strict ISO, not Postgres text (spike S2).
    expect(row?.lastEventAt).toBe(new Date(row!.lastEventAt!).toISOString());
    expect(row?.startedAt).toBe(at(60 * MINUTE));
    expect(row?.models).toEqual(["claude-opus-4"]);
  });

  // 9 ── The app role sees exactly what the owner does. If a policy ever filtered these rows the
  //      endpoint would return an empty queue with a 200 — the M15 `monitor.ts` failure shape.
  it("under the app role inside withOrg the queue matches the owner's", async () => {
    expect(ids(await queueAsApp())).toEqual(ids(await labelQueue(owner.db, orgA, OPTS)));
    expect((await queueAsApp()).length).toBeGreaterThan(0);
  });
});
