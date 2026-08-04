import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CaptureHealthSnapshot, IngestBatch, MachineConnectorReport } from "@420ai/shared";
import {
  createDb,
  ensurePersonalOrg,
  ingestBatch,
  issueIngestToken,
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

const ADMIN_EMAIL = "capture-health-admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse-battery";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in capture-health tests", "unavailable");
  },
};

/**
 * M16 16.3 — THE SLICE'S HTTP PROOF, and specifically its BEHAVIOURAL half.
 *
 * `routes/org-scoping.test.ts` is a structural grep that exempts any FILE containing `withOrg(`
 * anywhere, so it cannot tell whether a particular handler carries a working org context — that is
 * exactly how M15's `monitor.ts` shipped an alert-delivery pass on the unwrapped `app.db`, reading
 * zero rows silently under a strict policy while every owner-connected test stayed green. The only
 * thing that catches it is a test on the NON-OWNER role asserting the side effect actually happened.
 *
 * So the server here is built on `appRole` (`DATABASE_URL_TEST_APP`, `rolbypassrls = false`) and the
 * owner handle is used for setup only. A `GET /v1/capture-health` that forgot `withOrg` returns an
 * empty `rows` array with a 200 — which is precisely the plausible-looking zero this whole slice
 * exists to abolish, so the round-trip below asserts non-empty, state by state.
 */
function batch(tag: string, connector: string, ts: string): IngestBatch {
  return {
    records: [
      {
        sourceConnector: connector,
        sessionId: `session-${tag}`,
        sourceRecordId: `raw-${tag}`,
        payload: JSON.stringify({ from: tag }),
      },
    ],
    events: [
      {
        fingerprint: `${tag}-fp-1`,
        sourceConnector: connector,
        parserVersion: `${connector}@1`,
        rawRecordId: `raw-${tag}`,
        eventIndex: 0,
        eventType: "message.user",
        sessionId: `session-${tag}`,
        ts,
      },
    ],
  };
}

function report(over: Partial<MachineConnectorReport> = {}): MachineConnectorReport {
  return {
    id: "claude-code",
    enabled: true,
    approval: "approved",
    status: "stable",
    captureMethod: "jsonl tail",
    liveness: "streaming",
    tokens: "exact",
    cost: "computed",
    knownGaps: [],
    requiredPermissions: ["Read ~/.claude/projects"],
    custom: false,
    lastErrorMessage: null,
    lastErrorAt: null,
    errorCount: 0,
    ...over,
  };
}

describe.skipIf(!TEST_URL || !APP_URL)("M16 16.3 capture health (two-role HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let machineA: string;
  let machineToken: string;
  let tokenOwner: string;
  let tokenViewer: string;

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

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE machine_connectors, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    await seedBootstrapKey(owner.db, ADMIN_EMAIL);

    const userA = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    const userViewer = await setUserPassword(
      owner.db,
      "viewer@example.com",
      hashPassword(PASSWORD),
    );
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");

    // MOVE the auto-created personal membership rather than INSERTing a second one — the M15 15.4
    // seeding bug: `findPrincipalByEmail` resolves the FIRST membership, so an inserted second one
    // is silently shadowed and every "viewer" assertion would in fact be testing an owner.
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));

    const [m] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userA, name: "machine-a" })
      .returning({ id: machines.id });
    machineA = m!.id;
    machineToken = (await issueIngestToken(owner.db, machineA)).token;

    tokenOwner = await login("a@example.com");
    tokenViewer = await login("viewer@example.com");
  });

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  const heartbeat = (connectors?: MachineConnectorReport[]) =>
    app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
      payload: { queuePending: 0, queueInflight: 0, collectorVersion: "16.3.0", connectors },
    });

  const getHealth = async (token: string): Promise<CaptureHealthSnapshot> => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/capture-health",
      headers: asUser(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as CaptureHealthSnapshot;
  };

  it("401s with no principal", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capture-health" });
    expect(res.statusCode).toBe(401);
  });

  // `viewer` is the FLOOR of the ladder — there is no rung below it, so there is no 403 case to
  // assert here. Any member of the org may see whether their own capture is working.
  it("a viewer succeeds — the gate is the floor of the role ladder", async () => {
    await heartbeat([report()]);
    const body = await getHealth(tokenViewer);
    expect(body.captureHealthVersion).toBe("m16-capture-health-v1");
    expect(body.rows).toHaveLength(1);
  });

  // THE BEHAVIOURAL APP-ROLE TEST. A handler that forgot `withOrg` returns 200 + zero rows here.
  it("round-trips a reported inventory: declared-but-silent renders, an error renders erroring", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "claude-code", new Date().toISOString()));

    expect(
      (
        await heartbeat([
          report({ id: "claude-code" }),
          // Declared, live-capture, never produced an event, while a sibling on the SAME machine did.
          report({ id: "codex-cli", liveness: "near-real-time" }),
          // A batch connector's quiet is expected — it must never read as breakage (D-16.3-4).
          report({ id: "claude-export", liveness: "batch" }),
          report({ id: "gemini-cli", enabled: false }),
          report({ id: "cursor", approval: "needs-approval" }),
          report({
            id: "amp",
            lastErrorMessage: "EACCES: permission denied, open 'session.jsonl'",
            lastErrorAt: new Date().toISOString(),
            errorCount: 3,
          }),
        ])
      ).statusCode,
    ).toBe(200);

    const body = await getHealth(tokenOwner);
    const byId = new Map(body.rows.map((r) => [r.connectorId, r]));
    expect(body.rows).toHaveLength(6);

    expect(byId.get("claude-code")!.state).toBe("healthy");
    // THE ROW THAT DOES NOT EXIST WITHOUT THIS SLICE — `connectorHealth` returns nothing for it.
    expect(byId.get("codex-cli")!.state).toBe("silent");
    expect(byId.get("codex-cli")!.eventCount).toBe(0);
    expect(byId.get("claude-export")!.state).toBe("idle");
    expect(byId.get("gemini-cli")!.state).toBe("disabled");
    expect(byId.get("cursor")!.state).toBe("needs-approval");
    expect(byId.get("amp")!.state).toBe("erroring");
    expect(byId.get("amp")!.lastErrorMessage).toContain("EACCES");
    expect(byId.get("amp")!.errorCount).toBe(3);

    // The P0.1 distinction itself, asserted as a distinction and not as a set of labels.
    expect(byId.get("claude-export")!.verdict).toBe("capturing");
    expect(byId.get("gemini-cli")!.verdict).toBe("not-capturing");
    expect(byId.get("amp")!.verdict).toBe("broken");

    // §7 P0.1's "known permission gaps" reach the archive; `watchGlobs` deliberately do not.
    expect(byId.get("claude-code")!.requiredPermissions).toEqual(["Read ~/.claude/projects"]);
    expect(byId.get("claude-code")).not.toHaveProperty("watchGlobs");
    // No repository row leaks its tenancy column onto the wire (15.1).
    expect(byId.get("claude-code")).not.toHaveProperty("orgId");
  });

  it("events with no declaring machine render unreported, never disabled", async () => {
    await ingestBatch(owner.db, machineA, batch("A", "gemini-cli", new Date().toISOString()));
    await heartbeat([report({ id: "claude-code" })]);

    const body = await getHealth(tokenOwner);
    const orphan = body.rows.find((r) => r.connectorId === "gemini-cli");
    expect(orphan!.state).toBe("unreported");
    expect(orphan!.verdict).toBe("unknown");
    expect(orphan!.declared).toBe(false);
    expect(orphan!.enabled).toBeNull();
  });

  // D-16.3-2: `undefined` and `[]` are different facts and the route must not collapse them.
  it("a heartbeat with no `connectors` leaves the inventory alone; an empty array prunes it", async () => {
    await heartbeat([report({ id: "claude-code" })]);
    expect((await getHealth(tokenOwner)).rows).toHaveLength(1);

    // A pre-16.3 collector: reports nothing at all.
    expect((await heartbeat(undefined)).statusCode).toBe(200);
    expect((await getHealth(tokenOwner)).rows).toHaveLength(1);

    // A 16.3 collector that genuinely has zero connectors enabled.
    expect((await heartbeat([])).statusCode).toBe(200);
    expect((await getHealth(tokenOwner)).rows).toHaveLength(0);
  });

  /**
   * D-16.3-3, enforced at the EDGE and not merely at the type level — but by a different mechanism
   * than the plan assumed, so state the one that actually operates (the 15.5 rule).
   *
   * Fastify configures ajv with `removeAdditional: true` by default, so `additionalProperties:false`
   * STRIPS an undeclared property instead of rejecting the body. A collector that sent `watchGlobs`
   * therefore gets a 200 and the paths never reach Postgres. That is a strictly better privacy
   * outcome than a 400 (which would also have taken the machine's liveness down), but it is NOT the
   * loud rejection one might expect from reading the schema, so it is asserted here explicitly:
   * the assertion is on the DATABASE, which is the thing D-16.3-3 is actually about.
   */
  it("silently STRIPS watchGlobs at the edge — the paths never reach Postgres (D-16.3-3)", async () => {
    // A marker that appears NOWHERE else in the fixture — `requiredPermissions` legitimately
    // mentions `~/.claude/projects`, so asserting on that path would test the wrong string.
    const secretPath = "C:/Users/OPERATOR-HOME-MARKER/.claude/projects/**";
    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
      payload: {
        queuePending: 0,
        queueInflight: 0,
        collectorVersion: "16.3.0",
        connectors: [{ ...report(), watchGlobs: [secretPath] }],
      },
    });
    expect(res.statusCode).toBe(200);

    // Read on the OWNER handle so this sees past every policy: there must be no column anywhere in
    // the table holding the operator's home path, whatever the wire did.
    const dump = await owner.db.execute<{ row: string }>(
      sql`select machine_connectors::text as row from machine_connectors`,
    );
    expect(dump.rows).toHaveLength(1);
    expect(dump.rows[0]!.row).not.toContain("OPERATOR-HOME-MARKER");
    expect(dump.rows[0]!.row).not.toContain("C:/Users");
    // …and the row that DID land is otherwise intact, so the strip is surgical, not a dropped write.
    const body = await getHealth(tokenOwner);
    expect(body.rows[0]!.connectorId).toBe("claude-code");
  });

  /**
   * THE OTHER HALF OF THE SAME MECHANISM, and it CORRECTS the plan's D-16.3-6 premise, which said a
   * newer collector posting `connectors` to a pre-16.3 server would get a 400 for the whole
   * heartbeat. It would not: `removeAdditional` strips the unknown field and returns 200, so the
   * machine stays online and only the inventory is silently lost. That is a milder failure than
   * feared but a SILENT one, which is the class this slice exists to end — which is why the
   * collector's `onError` seam still matters, and why the deploy order (archive before collector)
   * is documented in `docs/guide/operations.md`.
   */
  it("an undeclared top-level heartbeat field is stripped, not rejected (D-16.3-6, corrected)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: { authorization: `Bearer ${machineToken}`, "content-type": "application/json" },
      payload: {
        queuePending: 0,
        queueInflight: 0,
        collectorVersion: "16.3.0",
        somethingFromTheFuture: { nested: true },
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
