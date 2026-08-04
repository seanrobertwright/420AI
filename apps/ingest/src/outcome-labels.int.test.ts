import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { IngestBatch } from "@420ai/shared";
import {
  createDb,
  ensurePersonalOrg,
  ingestBatch,
  machines,
  memberships,
  setUserPassword,
} from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

const ADMIN_EMAIL = "labels-admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse-battery";
/** A connector session id BOTH orgs happen to use — globally scoped, so it can collide. */
const SHARED_SESSION = "COLLIDING-SESSION-HTTP";
/** Org A's own session, used where a collision would confuse the assertion. */
const SESSION_A2 = "ORG-A-SESSION-2";

/**
 * A token-shaped string planted in `intent`. `redactJson` must strip it from the EXPORT while the
 * in-app read keeps it — D-16.1-7 asserted in both directions.
 */
const SECRET_INTENT = "ship it — key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in label tests", "unavailable");
  },
};

/**
 * M16 16.1 — THE SLICE'S HTTP PROOF. A TWO-ROLE, MULTI-USER suite.
 *
 * TWO POSTGRES ROLES, for the reason CLAUDE.md states as `bypassed ≠ enforced`: the `owner` handle
 * does setup only (TRUNCATE requires table ownership) and every assertion runs against an app built
 * on `appRole`, a non-owner with `rolbypassrls = false`. Test 1 is why the rest mean anything.
 *
 * WHAT THIS SUITE UNIQUELY PROVES, and what it does NOT. The 15.3 measurement applies verbatim: an
 * HTTP suite validates the PRIMARY defence — 15.2's explicit `orgId` predicates — and would stay
 * green under a wide-open policy, because those predicates scope the reads on their own. So the
 * BACKSTOP proof lives in `packages/db/src/repositories/outcome-labels.int.test.ts`. What this file
 * proves instead is the other half, which nothing else covers: that every one of the seven handlers
 * carries a working org context, that the RBAC ladder is real, that redaction fires on export and
 * not on the in-app read, and that the whole surface functions under the non-owner role at all.
 */
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

interface LabelResponse {
  label: {
    id: string;
    sessionId: string;
    authorUserId: string;
    status: string;
    taskType: string | null;
    intent: string | null;
    outcome: string | null;
    qualityRating: number | null;
    primaryFriction: string | null;
    followUpCommitOrPr: string | null;
    confidence: string | null;
    revision: number;
  };
}

const LABELED_BODY = {
  status: "labeled",
  taskType: "feature",
  intent: "ship the label API",
  outcome: "shipped",
  qualityRating: 4,
  primaryFriction: "none",
  confidence: "high",
} as const;

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.1 outcome labels (two-role HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userMember: string;
  let userViewer: string;
  let userAdmin: string;
  let userB: string;
  let tokenA: string;
  let tokenMember: string;
  let tokenViewer: string;
  let tokenAdmin: string;
  let tokenB: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
    app = buildApp({
      db: appRole.db,
      reconcileThrottleMs: 0,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await owner.pool.end();
    await appRole.pool.end();
  });

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const asJson = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  /**
   * MOVE an existing membership into org A at `role` — never INSERT a second one.
   *
   * `setUserPassword` auto-creates a personal `owner` membership via `ensurePersonalOrg`, and
   * `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`. So an INSERTed
   * second membership is silently SHADOWED, and every "viewer" assertion below would in fact be
   * testing an owner — green, and meaningless. This is the M15 15.4 seeding bug, and a multi-user
   * fixture that has never existed before is exactly where it hides.
   */
  async function moveMembership(userId: string, role: string): Promise<void> {
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role })
      .where(eq(memberships.userId, userId));
  }

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE outcome_label_revisions, outcome_labels, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // Mint the machine-tier bearer AFTER the truncate: `api_keys` FKs to `users` and cascades away.
    await seedBootstrapKey(owner.db, ADMIN_EMAIL);

    userA = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    userMember = await setUserPassword(owner.db, "member@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));
    userAdmin = await setUserPassword(owner.db, "admin@example.com", hashPassword(PASSWORD));
    userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgA).not.toBe(orgB);

    await moveMembership(userMember, "member");
    await moveMembership(userViewer, "viewer");
    await moveMembership(userAdmin, "admin");

    const [mA] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    const [mB] = await owner.db
      .insert(machines)
      .values({ orgId: orgB, userId: userB, name: "machine-b" })
      .returning({ id: machines.id });

    // Real events, or every POST 404s on the route's existence guard.
    await ingestBatch(owner.db, mA!.id, batch("A", SHARED_SESSION));
    await ingestBatch(owner.db, mA!.id, batch("A2", SESSION_A2));
    await ingestBatch(owner.db, mB!.id, batch("B", SHARED_SESSION));

    tokenA = await login("a@example.com");
    tokenMember = await login("member@example.com");
    tokenViewer = await login("viewer@example.com");
    tokenAdmin = await login("admin@example.com");
    tokenB = await login("b@example.com");
  });

  /** POST a `labeled` row for the given session as the given token. */
  const postLabel = (token: string, sessionId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/label`,
      headers: asJson(token),
      payload: body,
    });

  const countLabels = async () =>
    (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from outcome_labels`))
      .rows[0]!.n;

  // 0 ── the suite's own precondition. Without it every assertion below could be vacuous.
  it("the server's connection is the non-bypassing app role", async () => {
    const r = await appRole.db.execute<{ u: string; b: boolean }>(
      sql`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`,
    );
    expect(r.rows[0]!.u).toBe("420ai_app");
    expect(r.rows[0]!.b).toBe(false);
  });

  // 1 ── §7 P0.2's ACCEPTANCE, end to end: created → edited → history → exported → deleted.
  it("the full lifecycle works through HTTP", async () => {
    const created = await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);
    expect(created.statusCode).toBe(201);
    const label = (created.json() as LabelResponse).label;
    expect(label.revision).toBe(1);
    expect(label.outcome).toBe("shipped");
    expect(label.authorUserId).toBe(userA);
    // The tenant id must never reach the wire (the 15.1 lesson).
    expect(label).not.toHaveProperty("orgId");

    const read = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenA),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as LabelResponse).label.intent).toBe("ship the label API");

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { qualityRating: 2, primaryFriction: "context" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as LabelResponse).label.revision).toBe(2);
    expect((patched.json() as LabelResponse).label.qualityRating).toBe(2);

    const revisions = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label/revisions`,
      headers: asUser(tokenA),
    });
    expect(revisions.statusCode).toBe(200);
    const history = (
      revisions.json() as { revisions: { revision: number; qualityRating: number }[] }
    ).revisions;
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    // v1 keeps the ORIGINAL rating — this is what makes "preserve edits" a record, not a claim.
    expect(history[0]!.qualityRating).toBe(4);

    const listed = await app.inject({ method: "GET", url: "/v1/labels", headers: asUser(tokenA) });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { labels: unknown[] }).labels).toHaveLength(1);

    const exported = await app.inject({
      method: "GET",
      url: "/v1/labels/export?format=json",
      headers: asUser(tokenA),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["x-export-row-count"]).toBe("1");
    expect(exported.headers["x-export-truncated"]).toBe("false");
    expect(exported.headers["x-export-redaction-version"]).toBeTruthy();

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenA),
    });
    expect(removed.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenA),
    });
    expect(gone.statusCode).toBe(404);
    // The revisions went with it (D-16.1-6), counted on the owner handle so the assertion is
    // about the ROWS rather than about what a policy lets the app see.
    const revs = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from outcome_label_revisions`,
    );
    expect(revs.rows[0]!.n).toBe(0);
  });

  // 2 ── D-16.1-2. A SKIP IS A ROW, and a second offer is a 409 — which is what makes "never nag"
  //      implementable at all: 16.2 asks the archive whether it already offered.
  it("a skip persists with null fields, and a second POST is 409", async () => {
    const skipped = await postLabel(tokenA, SHARED_SESSION, { status: "skipped" });
    expect(skipped.statusCode).toBe(201);
    const label = (skipped.json() as LabelResponse).label;
    expect(label.status).toBe("skipped");
    for (const f of [
      label.taskType,
      label.intent,
      label.outcome,
      label.qualityRating,
      label.primaryFriction,
      label.followUpCommitOrPr,
      label.confidence,
    ]) {
      expect(f).toBeNull();
    }

    const again = await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);
    expect(again.statusCode).toBe(409);
    expect((again.json() as { reason: string }).reason).toBe("already_labeled");
    // A conflict must not overwrite: the skip is still the stored state.
    expect(await countLabels()).toBe(1);
  });

  // 3 ── THE EXISTENCE GUARD. A bogus session id must not create an orphan label — the row that
  //      would silently corrupt 16.4's denominator, since no FK exists to catch it.
  it("POST for a session with zero events is 404 and creates NO row", async () => {
    const res = await postLabel(tokenA, "NO-SUCH-SESSION-ANYWHERE", LABELED_BODY);
    expect(res.statusCode).toBe(404);
    // A status code alone would not prove it — count the rows.
    expect(await countLabels()).toBe(0);
  });

  /**
   * 3b ── THE EXISTENCE GUARD IS ORG-SCOPED, which is the case that can break silently.
   *
   * Test 3 uses a session id that exists nowhere, so it passes even if `sessionDetail`'s `orgId`
   * argument were dropped or transposed. `SESSION_A2` exists ONLY in org A and is the probe that
   * discriminates: without the org predicate, org B could create a label against org A's session —
   * an orphan in B's tenant pointing at a session B cannot see, corrupting 16.4's denominator on
   * both sides.
   */
  it("org B cannot label a session that exists only in org A", async () => {
    const res = await postLabel(tokenB, SESSION_A2, LABELED_BODY);
    expect(res.statusCode).toBe(404);
    expect(await countLabels()).toBe(0);
  });

  // 4 ── D-16.1-3 / 15.2. Two tenants sharing a connector session id stay completely separate.
  it("org B cannot see org A's label for a SHARED session id", async () => {
    await postLabel(tokenA, SHARED_SESSION, { ...LABELED_BODY, intent: "ORG-A-ONLY-INTENT" });

    const bRead = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenB),
    });
    // 404, never 403 and never A's content: a 403 would confirm the row exists in another tenant.
    expect(bRead.statusCode).toBe(404);
    expect(bRead.body).not.toContain("ORG-A-ONLY-INTENT");

    const bList = await app.inject({ method: "GET", url: "/v1/labels", headers: asUser(tokenB) });
    expect(bList.statusCode).toBe(200);
    expect((bList.json() as { labels: unknown[] }).labels).toHaveLength(0);
    expect(bList.body).not.toContain("ORG-A-ONLY-INTENT");

    // And B may label the SAME session id independently — the unique index is (org_id, session_id).
    const bWrite = await postLabel(tokenB, SHARED_SESSION, { ...LABELED_BODY, intent: "B-INTENT" });
    expect(bWrite.statusCode).toBe(201);
    expect(await countLabels()).toBe(2);
  });

  // 5 ── D-16.1-7. REDACTION ON EXPORT, NOT ON THE IN-APP READ — asserted in BOTH directions,
  //      because a test that only checks the export cannot tell redaction from an empty field.
  it("a token-shaped intent is redacted in the export but present in the in-app read", async () => {
    await postLabel(tokenA, SHARED_SESSION, { ...LABELED_BODY, intent: SECRET_INTENT });

    const read = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenA),
    });
    expect(read.body).toContain("sk-ant-api03");

    // A `not.toContain` on its own is VACUOUS — an empty body passes it, and so would a redactor
    // that deleted the field rather than masking it, or a broken serializer. So each format also
    // asserts the row is actually THERE and that `intent` survived as a changed, non-empty string.
    for (const format of ["json", "jsonl", "csv"] as const) {
      const exported = await app.inject({
        method: "GET",
        url: `/v1/labels/export?format=${format}`,
        headers: asUser(tokenA),
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.body, `${format} export must be redacted`).not.toContain("sk-ant-api03");
      expect(exported.headers["x-export-row-count"], `${format} row count`).toBe("1");
      expect(exported.body.length, `${format} export must not be empty`).toBeGreaterThan(0);

      if (format === "json") {
        const parsed = exported.json() as {
          manifest: {
            subject: string;
            format: string;
            rowCount: number;
            truncated: boolean;
            redactionVersion: string;
          };
          rows: { intent: string; sessionId: string }[];
        };
        expect(parsed.manifest.subject).toBe("labels");
        expect(parsed.manifest.format).toBe("json");
        expect(parsed.manifest.rowCount).toBe(1);
        expect(parsed.manifest.truncated).toBe(false);
        expect(parsed.manifest.redactionVersion).toBeTruthy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0]!.sessionId).toBe(SHARED_SESSION);
        // MASKED, not dropped: still a non-empty string, and no longer the original.
        expect(parsed.rows[0]!.intent).toBeTruthy();
        expect(parsed.rows[0]!.intent).not.toBe(SECRET_INTENT);
      } else if (format === "jsonl") {
        const lines = exported.body.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(() => JSON.parse(lines[0]!)).not.toThrow();
      } else {
        const lines = exported.body.trim().split("\r\n");
        // Pins the CSV column ORDER, which nothing else does — a reordered header silently breaks
        // every downstream consumer that reads by position.
        expect(lines[0]).toBe(
          "id,sessionId,authorUserId,status,taskType,intent,outcome,qualityRating,primaryFriction,followUpCommitOrPr,confidence,revision,createdAt,updatedAt",
        );
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain(SHARED_SESSION);
      }
    }
  });

  // 6 ── RBAC (D-16.1-4). A `viewer` reads everything in their org and writes nothing.
  it("a viewer gets 403 on POST/PATCH/DELETE and 200 on the reads", async () => {
    await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);

    const write = await postLabel(tokenViewer, SESSION_A2, LABELED_BODY);
    expect(write.statusCode).toBe(403);
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenViewer),
      payload: { qualityRating: 1 },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenViewer),
    });
    // 403 from the ROUTE gate. That gate is the only layer that can be loud here — a policy-blocked
    // DELETE is a silent `DELETE 0` (no WITH CHECK for DELETE in Postgres), which is exactly why
    // the gate must be complete rather than merely present.
    expect(del.statusCode).toBe(403);
    expect(await countLabels()).toBe(1);

    for (const url of [
      `/v1/sessions/${SHARED_SESSION}/label`,
      `/v1/sessions/${SHARED_SESSION}/label/revisions`,
      "/v1/labels",
      "/v1/labels/export?format=json",
      "/v1/labels/queue", // M16 16.2 — a read, so `viewer` is its floor too.
    ]) {
      const res = await app.inject({ method: "GET", url, headers: asUser(tokenViewer) });
      expect(res.statusCode, `viewer GET ${url}`).toBe(200);
    }
  });

  // 7 ── D-16.1-4. AUTHOR-ONLY EDIT, through HTTP, and the DELETE asymmetry beside it.
  it("a colleague cannot PATCH another's label (403) or DELETE it (404), but an admin can", async () => {
    await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenMember),
      payload: { qualityRating: 1 },
    });
    // 403 — the label is an opinion with a name on it, and 16.4 reads these rows as EVIDENCE.
    expect(patch.statusCode).toBe(403);
    expect((patch.json() as { reason: string }).reason).toBe("not_author");

    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenMember),
    });
    // 404, NOT 403, and the asymmetry with PATCH above is deliberate: a non-author has no claim on
    // the row at all, so confirming it exists would tell them about a colleague's judgement.
    expect(memberDelete.statusCode).toBe(404);
    expect(await countLabels()).toBe(1);

    // Retraction is not rewriting, so an admin DOES get the data-hygiene lever.
    const adminDelete = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenAdmin),
    });
    expect(adminDelete.statusCode).toBe(204);
    expect(await countLabels()).toBe(0);
  });

  // 8 ── EDGE CASES AT THE SCHEMA BOUNDARY. Each is a 400 before the handler runs.
  it("rejects an empty patch, an over-long intent and an out-of-range rating", async () => {
    await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);

    // `minProperties: 1` — an empty PATCH must not bump `revision` and append an identical
    // snapshot, which would pollute the one record 16.4 reads as evidence of what changed.
    const empty = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    // §4.3's own 200-character limit, asserted from BOTH sides of the boundary.
    const at200 = await postLabel(tokenA, SESSION_A2, {
      ...LABELED_BODY,
      intent: "x".repeat(200),
    });
    expect(at200.statusCode).toBe(201);
    const over = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SESSION_A2}/label`,
      headers: asJson(tokenA),
      payload: { intent: "x".repeat(201) },
    });
    expect(over.statusCode).toBe(400);

    for (const qualityRating of [0, 6]) {
      const bad = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${SESSION_A2}/label`,
        headers: asJson(tokenA),
        payload: { qualityRating },
      });
      expect(bad.statusCode, `rating ${qualityRating}`).toBe(400);
    }

    // The un-normalized §4.3 spelling must not enter the archive by a side door.
    const badFriction = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SESSION_A2}/label`,
      headers: asJson(tokenA),
      payload: { primaryFriction: "model/tool" },
    });
    expect(badFriction.statusCode).toBe(400);

    // A `labeled` create missing a required §4.3 field is a 400 that NAMES the field, rather than
    // a row with a value no human chose.
    const incomplete = await postLabel(tokenA, SESSION_A2, { status: "labeled" });
    expect(incomplete.statusCode).toBe(400);
    expect((incomplete.json() as { error: string }).error).toContain("outcome");
  });

  /**
   * 8b ── THE `labeled`/`skipped` INVARIANT, THROUGH HTTP (regression, 16.1 code review).
   *
   * The repository suite pins the guard itself; this pins that the ROUTE surfaces it as a 400 with
   * the field names, rather than as a 500 or a silent 200.
   */
  it("PATCH status transitions are coherent: skip clears, and an empty upgrade is 400", async () => {
    await postLabel(tokenA, SHARED_SESSION, LABELED_BODY);

    // Downgrade to a skip CLEARS the judgement (it stays readable in the revision history).
    const skipped = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { status: "skipped" },
    });
    expect(skipped.statusCode).toBe(200);
    const row = (skipped.json() as LabelResponse).label;
    expect(row.status).toBe("skipped");
    expect(row.outcome).toBeNull();
    expect(row.qualityRating).toBeNull();

    const history = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SHARED_SESSION}/label/revisions`,
      headers: asUser(tokenA),
    });
    expect(
      (history.json() as { revisions: { outcome: string | null }[] }).revisions[0]!.outcome,
    ).toBe("shipped");

    // Upgrading back to `labeled` with no judgement is a 400 that NAMES the missing fields — ALL
    // five of them, so a guard that reported only the first would fail this.
    const empty = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { status: "labeled" },
    });
    expect(empty.statusCode).toBe(400);
    const err = empty.json() as { error: string; reason: string };
    expect(err.reason).toBe("incomplete_label");
    for (const field of [
      "taskType",
      "intent",
      "outcome",
      "qualityRating",
      "primaryFriction",
    ] as const) {
      expect(err.error, `400 must name ${field}`).toContain(field);
    }

    // REGRESSION (prp-review): sending fields to a row that is STILL skipped, without also sending
    // `status: "labeled"`, must be refused rather than silently discarded behind a 200.
    const sneaky = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { qualityRating: 5 },
    });
    expect(sneaky.statusCode).toBe(400);
    expect((sneaky.json() as { reason: string }).reason).toBe("incomplete_label");
  });

  // 8d ── The `not_found → 404` arm of the OutcomeLabelError map is otherwise never exercised
  //       through HTTP (409/403/400 all are), so a wrong ternary arm would ship silently.
  it("PATCH and DELETE on an unlabeled session are 404 with the right reason", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SESSION_A2}/label`,
      headers: asJson(tokenA),
      payload: { qualityRating: 3 },
    });
    expect(patched.statusCode).toBe(404);
    expect((patched.json() as { reason: string }).reason).toBe("not_found");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SESSION_A2}/label`,
      headers: asUser(tokenA),
    });
    expect(deleted.statusCode).toBe(404);
  });

  // 8c ── The two §4.3 OPTIONAL fields accept an explicit `null` over the wire; the required ones
  //       do not. Before the fix the repository documented null-means-clear and the schema 400'd it.
  it("null clears followUpCommitOrPr/confidence but is rejected for a required field", async () => {
    await postLabel(tokenA, SHARED_SESSION, {
      ...LABELED_BODY,
      followUpCommitOrPr: "https://github.com/x/y/pull/1",
    });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { followUpCommitOrPr: null, confidence: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as LabelResponse).label.followUpCommitOrPr).toBeNull();
    expect((cleared.json() as LabelResponse).label.confidence).toBeNull();

    // A required field stays non-nullable at the edge — ajv refuses before the handler runs.
    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { outcome: null },
    });
    expect(bad.statusCode).toBe(400);
  });

  // 9 ── Every handler refuses an anonymous caller. Cheap, and it is the check that would catch a
  //      handler pasted in without its `resolvePrincipal` guard.
  it("all eight routes are 401 without a bearer", async () => {
    const calls: [string, string][] = [
      ["POST", `/v1/sessions/${SHARED_SESSION}/label`],
      ["GET", `/v1/sessions/${SHARED_SESSION}/label`],
      ["PATCH", `/v1/sessions/${SHARED_SESSION}/label`],
      ["DELETE", `/v1/sessions/${SHARED_SESSION}/label`],
      ["GET", `/v1/sessions/${SHARED_SESSION}/label/revisions`],
      ["GET", "/v1/labels"],
      ["GET", "/v1/labels/export?format=json"],
      ["GET", "/v1/labels/queue"], // M16 16.2 — the eighth.
    ];
    for (const [method, url] of calls) {
      // The content-type header goes ONLY on the two methods that carry a body. Sending it on a
      // bodiless DELETE makes Fastify reject the empty payload as malformed JSON — a 400 raised
      // before the handler (and therefore before `resolvePrincipal`) ever runs, which would make
      // this assertion fail for a reason that has nothing to do with authentication.
      const hasBody = method === "POST" || method === "PATCH";
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: hasBody ? { "content-type": "application/json" } : {},
        payload: hasBody ? LABELED_BODY : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  /**
   * 11 ── M16 16.2, GET /v1/labels/queue. THE BEHAVIOURAL HALF OF CLAUDE.md's GREP RULE.
   *
   * `routes/org-scoping.test.ts` is FILE-granular — one `withOrg(` anywhere exempts the whole file —
   * so `outcome-labels.ts` already passed it before this endpoint existed and would keep passing if
   * the new handler forgot the wrapper entirely. Source text cannot tell a `Tx` from a `Db`.
   *
   * What it also cannot catch is the opposite failure, and that one is worse: a handler that DOES
   * carry a context but reads a strict-policy table under the wrong role returns ZERO ROWS with a
   * 200 — no error, no log, nothing for a `try/catch` to swallow. That is the M15 `monitor.ts`
   * alert-delivery bug verbatim, and an empty label queue is exactly its shape here: the operator
   * would see "Nothing to label", conclude they were up to date, and 16.4's denominator would be
   * silently wrong. So this asserts the side effect ACTUALLY HAPPENED (`length > 0`) under the
   * non-owner role, rather than merely that the call returned 200.
   *
   * The session is seeded with a ts relative to REAL now, because the ROUTE owns the clock here and
   * cannot be injected — a hardcoded date would make this test a time bomb that passes until the
   * 14-day lookback rolls past it.
   */
  it("the queue returns a settled unlabeled session under the app role, and a skip removes it", async () => {
    const QUEUE_SESSION = "QUEUE-SETTLED-SESSION";
    const [mQ] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-queue" })
      .returning({ id: machines.id });
    // One hour ago: past the 15-minute settle window, far inside the 14-day lookback.
    const settledTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await ingestBatch(owner.db, mQ!.id, {
      records: [
        {
          sourceConnector: "claude-code",
          sessionId: QUEUE_SESSION,
          sourceRecordId: "raw-queue",
          payload: JSON.stringify({ from: "queue" }),
        },
      ],
      events: [
        {
          fingerprint: "queue-fp-1",
          sourceConnector: "claude-code",
          parserVersion: "1.0.0",
          rawRecordId: "raw-queue",
          eventIndex: 0,
          eventType: "message.user",
          sessionId: QUEUE_SESSION,
          ts: settledTs,
        },
      ],
    });

    const readQueue = async (token: string) => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/labels/queue",
        headers: asUser(token),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { sessions: { sessionId: string; lastEventAt: string | null }[] })
        .sessions;
    };

    const before = await readQueue(tokenA);
    // NOT merely `toBe(200)`: a silently-filtered read is a 200 with an empty array.
    expect(before.length).toBeGreaterThan(0);
    const row = before.find((s) => s.sessionId === QUEUE_SESSION);
    expect(row, "the settled session must be offered for labelling").toBeDefined();
    // The aggregate timestamp is strict ISO, not Postgres text (the M5/M9 bug class).
    expect(row!.lastEventAt).toBe(new Date(row!.lastEventAt!).toISOString());

    // §4.3's "offer skip and do not nag repeatedly", end to end: a SKIP is a row (D-16.1-2), so the
    // same `count(labels.id) = 0` predicate that hides a judged session hides a declined one.
    const skipped = await postLabel(tokenA, QUEUE_SESSION, { status: "skipped" });
    expect(skipped.statusCode).toBe(201);

    const after = await readQueue(tokenA);
    expect(after.map((s) => s.sessionId)).not.toContain(QUEUE_SESSION);

    // Org B must never see org A's session, even though the queue is keyed on a connector string.
    expect((await readQueue(tokenB)).map((s) => s.sessionId)).not.toContain(QUEUE_SESSION);
  });

  /**
   * 12 ── THE CLIENT CANNOT WIDEN THE WINDOW. `settledBeforeIso`/`sinceIso` are not caller input
   * (D-16.2-2), and this pins the two different mechanisms that make that true.
   *
   * AN UNKNOWN KEY IS STRIPPED, NOT REJECTED — 200, not 400, and the distinction is worth a test
   * rather than a guess. This app registers no custom ajv instance, so Fastify's DEFAULT
   * `removeAdditional: true` applies to querystrings: with `additionalProperties: false` ajv
   * DELETES the unknown property instead of raising. Every querystring schema in `schemas.ts`
   * behaves this way, so do not "fix" a sibling route to 400 on the strength of the schema alone.
   * The security property still holds — a stripped key reaches no handler — but it holds by
   * REMOVAL, which is a quieter mechanism than the schema's shape suggests.
   *
   * A BAD `limit` IS a 400, because that is a value constraint on a declared property, which ajv
   * does raise. So the bound is enforced loudly and the window is enforced silently, and both are
   * asserted here so a later reader does not have to infer which is which.
   */
  it("the queue ignores an injected window key and rejects an out-of-range limit", async () => {
    const injected = await app.inject({
      method: "GET",
      // A caller trying to reach back past the 14-day lookback, or to shrink the settle window so a
      // still-active session is offered for judgement.
      url: "/v1/labels/queue?settledBeforeIso=2020-01-01T00:00:00.000Z&sinceIso=2000-01-01T00:00:00.000Z",
      headers: asUser(tokenA),
    });
    expect(injected.statusCode).toBe(200);
    // …and it changed nothing: the aged-out seed session (ts 2026-08-01, fixed) is governed by the
    // SERVER's windows either way. What matters is that the handler never saw those keys.
    const sessions = (injected.json() as { sessions: { sessionId: string }[] }).sessions;
    expect(Array.isArray(sessions)).toBe(true);

    const tooBig = await app.inject({
      method: "GET",
      url: "/v1/labels/queue?limit=500",
      headers: asUser(tokenA),
    });
    expect(tooBig.statusCode).toBe(400);

    const zero = await app.inject({
      method: "GET",
      url: "/v1/labels/queue?limit=0",
      headers: asUser(tokenA),
    });
    expect(zero.statusCode).toBe(400);
  });

  // 10 ── §7 P0.2's CENTRAL CLAIM, at the HTTP layer: the whole label lifecycle is not a mutation
  //       of a raw record. Asserted rather than assumed, and counted on the owner handle.
  it("creating, editing and deleting a label leaves events and raw records untouched", async () => {
    const countEvents = async () =>
      (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from events`)).rows[0]!
        .n;
    const countRaw = async () =>
      (
        await owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from raw_source_records`,
        )
      ).rows[0]!.n;

    const eventsBefore = await countEvents();
    const rawBefore = await countRaw();
    expect(eventsBefore).toBeGreaterThan(0);

    expect((await postLabel(tokenA, SHARED_SESSION, LABELED_BODY)).statusCode).toBe(201);
    await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asJson(tokenA),
      payload: { outcome: "abandoned" },
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${SHARED_SESSION}/label`,
      headers: asUser(tokenA),
    });

    expect(await countEvents()).toBe(eventsBefore);
    expect(await countRaw()).toBe(rawBefore);
  });
});
