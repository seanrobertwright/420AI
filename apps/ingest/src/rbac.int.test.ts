import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  alertFirings,
  createDb,
  ensurePersonalOrg,
  machines,
  memberships,
  pricingCatalogs,
  projects,
  setUserPassword,
  withOrg,
} from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const SERVICE_TOKEN = "svc-token";
const ADMIN_EMAIL = "admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in RBAC tests", "unavailable");
  },
};

/**
 * M15 15.4 — THE SLICE'S PROOF. A TWO-ROLE, MULTI-USER suite.
 *
 * Two things make this file different from every suite before it, and both are the point:
 *
 *   1. TWO USERS IN ONE ORG. That configuration has never existed in this repo — every org was
 *      personal and single-user, which is exactly what made twelve `userId`-only reads look
 *      correct. Test "two members of one org see the same data" fails BEFORE task 9 and passes
 *      after; a test that never failed proves nothing.
 *   2. TWO POSTGRES ROLES. `owner` (DATABASE_URL_TEST) does setup only — TRUNCATE requires table
 *      ownership. Every assertion runs against an app built on `appRole`
 *      (DATABASE_URL_TEST_APP), a non-owner with `rolbypassrls = false`. Against the owner the
 *      0016 restrictive policies are INERT, so an owner-connected suite would report green while
 *      enforcing nothing: `bypassed ≠ enforced`.
 *
 * Test 1 is why the rest mean anything. Point the "app" handle at the owner URL by mistake and
 * every backstop test below would still pass — while proving the opposite of what it claims.
 */

/** Flatten an error and its `cause` chain — drizzle wraps the real Postgres error. */
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

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.4 RBAC (two-role, two-user)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let userOwner: string;
  let userMember: string;
  let userViewer: string;
  let machineOwned: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
    app = buildApp({
      db: appRole.db,
      adminToken: SERVICE_TOKEN,
      // Reconcile on EVERY tick, so a firing assertion never races the 30 s production throttle.
      reconcileThrottleMs: 0,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    // The app AND both pools, or vitest hangs on an open handle.
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
    expect(res.statusCode, `login for ${email}`).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await owner.db.delete(pricingCatalogs);
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    userMember = await setUserPassword(owner.db, "member@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));

    // ── THE NEW SHAPE: ONE org, THREE users, THREE different rungs. ──
    //
    // `setUserPassword` calls `ensurePersonalOrg` internally, so EVERY user above already holds
    // an 'owner' membership in their own personal org. So the other two are MOVED into org A at
    // the right rung rather than given a second membership: `findPrincipalByEmail` resolves the
    // FIRST membership by (created_at, id), so an added row would be shadowed by the personal
    // 'owner' one and every role assertion in this file would silently test an owner. (That is
    // not a hypothetical — it is what the first run of this suite actually did.)
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "member" })
      .where(eq(memberships.userId, userMember));
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));

    // A SECOND org (the bootstrap admin's), for the per-org firing fan-out check.
    orgB = await ensurePersonalOrg(owner.db, await adminUserId(), ADMIN_EMAIL);
    expect(orgA).not.toBe(orgB);

    // A machine owned by userOwner. userViewer never owns one — which is precisely why the old
    // `userId`-only `machineStatuses` returned an EMPTY monitor for a colleague.
    const [m] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userOwner, name: "owner-laptop" })
      .returning({ id: machines.id });
    machineOwned = m!.id;
  });

  /** The env-seeded bootstrap admin's user id (created by setUserPassword above). */
  async function adminUserId(): Promise<string> {
    const r = await owner.db.execute<{ id: string }>(
      sql`select id from users where email = ${ADMIN_EMAIL}`,
    );
    return r.rows[0]!.id;
  }

  // 1 ── ROLE IDENTITY. Non-negotiable, and first: without it this whole file is theatre.
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

  // 2 ── READS ARE UNAFFECTED BY ROLE. A viewer is entitled to read their own org — which is
  //      exactly why D-15.4-3 puts NO restrictive policy on SELECT.
  it("a viewer may READ: GET /v1/monitor, /v1/projects and /v1/auth/me all return 200", async () => {
    const viewer = asUser(await login("viewer@example.com"));
    for (const url of ["/v1/auth/me", "/v1/monitor", "/v1/projects", "/v1/workspaces"]) {
      const res = await app.inject({ method: "GET", url, headers: viewer });
      expect(res.statusCode, `viewer GET ${url}`).toBe(200);
    }
  });

  // 3 ── THE ROUTE GATE, on a member-level write.
  it("a viewer POSTing /v1/projects is 403, and the project is not created", async () => {
    const viewer = asUser(await login("viewer@example.com"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...viewer, "content-type": "application/json" },
      payload: { name: "should-not-exist" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient role" });
    const rows = await owner.db.select().from(projects);
    expect(rows).toHaveLength(0);
  });

  // 4 ── THE ROUTE GATE, on an admin-level maintenance op. A read-only account must not be able
  //      to rewrite the archive.
  it("a viewer POSTing /v1/replay/reparse is 403", async () => {
    const viewer = asUser(await login("viewer@example.com"));
    const res = await app.inject({ method: "POST", url: "/v1/replay/reparse", headers: viewer });
    expect(res.statusCode).toBe(403);
  });

  // 5 ── THE LADDER IS ORDERED, not a set of equalities. A member clears `member` and fails
  //      `admin` in the same session — the single most likely place for an off-by-one rung.
  it("a member may create a project but may NOT reindex the search corpus", async () => {
    const member = asUser(await login("member@example.com"));
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...member, "content-type": "application/json" },
      payload: { name: "member-made-this" },
    });
    expect(created.statusCode).toBe(200);

    const reindex = await app.inject({
      method: "POST",
      url: "/v1/search/reindex",
      headers: member,
    });
    expect(reindex.statusCode).toBe(403);
  });

  // 6 ── AUDIT B.6: the approval records a real identity, not the literal "admin".
  it("an admin approves a catalog and approved_by is THEIR EMAIL, never the string 'admin'", async () => {
    const [pending] = await owner.db
      .insert(pricingCatalogs)
      .values({ version: "rbac-catalog-v1", payload: {}, signature: "sig", status: "pending" })
      .returning({ id: pricingCatalogs.id });

    // The bootstrap admin resolves to an 'owner' membership, which clears the `admin` rung.
    const admin = asUser(await login(ADMIN_EMAIL));
    const res = await app.inject({
      method: "POST",
      url: `/v1/catalog/${pending!.id}/approve`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);

    const [row] = await owner.db
      .select({ approvedBy: pricingCatalogs.approvedBy, status: pricingCatalogs.status })
      .from(pricingCatalogs)
      .where(eq(pricingCatalogs.id, pending!.id));
    expect(row!.status).toBe("active");
    expect(row!.approvedBy).toBe(ADMIN_EMAIL);
    expect(row!.approvedBy).not.toBe("admin");

    // …and a viewer cannot approve at all.
    const [second] = await owner.db
      .insert(pricingCatalogs)
      .values({ version: "rbac-catalog-v2", payload: {}, signature: "sig", status: "pending" })
      .returning({ id: pricingCatalogs.id });
    const viewer = asUser(await login("viewer@example.com"));
    const denied = await app.inject({
      method: "POST",
      url: `/v1/catalog/${second!.id}/approve`,
      headers: viewer,
    });
    expect(denied.statusCode).toBe(403);
  });

  // 7 ── THE BACKSTOP, WITH THE ROUTE GATE BYPASSED. This is the test that proves a SECOND layer
  //      exists: it never touches HTTP, so no `authorized()` call can be responsible for it.
  it("a viewer-context INSERT is rejected by the database itself (restrictive policy)", async () => {
    await expectRlsRejection(
      withOrg(appRole.db, orgA, "viewer", (tx) =>
        tx.insert(projects).values({ orgId: orgA, userId: userViewer, name: "backstopped" }),
      ),
    );
    // …while the SAME statement under a member context succeeds. Without this half, a broken
    // org policy (rejecting everything) would look like a working role policy.
    await expect(
      withOrg(appRole.db, orgA, "member", (tx) =>
        tx.insert(projects).values({ orgId: orgA, userId: userMember, name: "permitted" }),
      ),
    ).resolves.toBeDefined();
  });

  // 8 ── THE SILENT DELETE. Asserted EXPLICITLY so nobody later "fixes" it into an expectation
  //      of an error Postgres cannot produce: there is no WITH CHECK for DELETE, so a blocked
  //      delete is unavoidably `DELETE 0`. The route gate is the only loud layer for deletes.
  it("a viewer-context DELETE affects ZERO rows and does NOT throw", async () => {
    await owner.db.insert(alertFirings).values({
      orgId: orgA,
      userId: userOwner,
      alertKey: "rbac.silent-delete",
      code: "collector.offline",
      severity: "warning",
      message: "m",
      status: "open",
      firstFiredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const deleted = await withOrg(appRole.db, orgA, "viewer", (tx) =>
      tx
        .delete(alertFirings)
        .where(and(eq(alertFirings.orgId, orgA), eq(alertFirings.userId, userOwner)))
        .returning({ id: alertFirings.id }),
    );
    expect(deleted).toEqual([]); // silent — no throw, no error, nothing to log

    // The row is still there: the backstop filtered rather than raised.
    const still = await owner.db.select().from(alertFirings);
    expect(still).toHaveLength(1);

    // And a member context CAN delete it — proving the silence above was the ROLE policy and
    // not, say, a missing grant or a wrong predicate.
    const removed = await withOrg(appRole.db, orgA, "member", (tx) =>
      tx
        .delete(alertFirings)
        .where(and(eq(alertFirings.orgId, orgA), eq(alertFirings.userId, userOwner)))
        .returning({ id: alertFirings.id }),
    );
    expect(removed).toHaveLength(1);
  });

  // 9 ── UNSET ROLE ⇒ WRITES PERMITTED. The coalesce default is 'member' on purpose: machine
  //      paths pass SERVICE_ROLE, and a context with NO role at all (a legacy caller) must still
  //      write, or every collector ingest 500s. Pinned so nobody "hardens" it into failing closed.
  it("a context with NO role set may still write (the permissive coalesce default)", async () => {
    await appRole.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org', ${orgA}, true)`);
      // Deliberately NO set_config for app.current_role.
      await expect(
        tx.insert(projects).values({ orgId: orgA, userId: userOwner, name: "legacy-caller" }),
      ).resolves.toBeDefined();
    });
  });

  // 10 ── SERVICE_ROLE writes, but authorizes NOTHING. The two halves of the sentinel.
  it("the SERVICE sentinel satisfies the RLS backstop yet is not a membership rung", async () => {
    await expect(
      withOrg(appRole.db, orgA, "service", (tx) =>
        tx.insert(projects).values({ orgId: orgA, userId: userOwner, name: "machine-made" }),
      ),
    ).resolves.toBeDefined();
    // The route layer is the strict one — `authorized()` is proven against the sentinel in
    // `authorize.test.ts`; the DB layer only ever asks "is this a viewer?".
  });

  // 11 ── THE ORG-PREDICATE REGRESSION. THIS is the test that fails BEFORE task 9's conversion:
  //       under the old `userId`-only `machineStatuses`, a colleague's monitor was EMPTY.
  it("two members of ONE org see the SAME org data (the userId-only read regression)", async () => {
    const seen = async (email: string): Promise<string[]> => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/monitor",
        headers: asUser(await login(email)),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { machines: { id: string }[] }).machines.map((m) => m.id);
    };
    // The machine belongs to userOwner. Before 15.4 the viewer — a full member of the same org,
    // entitled to see it — got `[]`, because the read filtered on `user_id` alone.
    expect(await seen("owner@example.com")).toEqual([machineOwned]);
    expect(await seen("viewer@example.com")).toEqual([machineOwned]);
    expect(await seen("member@example.com")).toEqual([machineOwned]);
  });

  // 12 ── D-M15-6: the per-org firing fan-out is ALREADY satisfied by 15.3's per-(org,user)
  //       snapshot. CONFIRMED here rather than assumed — the residue 15.4 fixed was the
  //       hardcoded approver (test 6), not the fan-out.
  it("two orgs pending the same catalog approval EACH get their own firing", async () => {
    await owner.db
      .insert(pricingCatalogs)
      .values({ version: "fanout-v1", payload: {}, signature: "sig", status: "pending" });

    for (const email of ["owner@example.com", ADMIN_EMAIL]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/monitor",
        headers: asUser(await login(email)),
      });
      expect(res.statusCode).toBe(200);
    }

    const rows = await owner.db
      .select({ orgId: alertFirings.orgId })
      .from(alertFirings)
      .where(eq(alertFirings.code, "catalog.update_requires_approval"));
    const orgsWithFiring = new Set(rows.map((r) => r.orgId));
    expect(orgsWithFiring.has(orgA)).toBe(true);
    expect(orgsWithFiring.has(orgB)).toBe(true);
  });

  // 13 ── THE THROTTLE (audit B.4). With a long window, two consecutive GETs perform ONE
  //       reconcile — and the second STILL returns the full firing list, because a non-reconcile
  //       tick serves the persisted rows rather than an empty array.
  it("reconcileThrottleMs collapses two consecutive snapshots into one reconcile write", async () => {
    const throttled = buildApp({
      db: appRole.db,
      adminToken: SERVICE_TOKEN,
      reconcileThrottleMs: 60_000,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      logger: false,
    });
    await throttled.ready();
    try {
      const token = (
        await throttled
          .inject({
            method: "POST",
            url: "/v1/auth/login",
            headers: { "content-type": "application/json" },
            payload: { email: "owner@example.com", password: PASSWORD },
          })
          .then((r) => r.json())
      ).token as string;
      const get = () =>
        throttled.inject({ method: "GET", url: "/v1/monitor", headers: asUser(token) });

      // The seeded machine has never sent a heartbeat, so the first snapshot DERIVES a
      // `collector.offline` alert and reconciles it open.
      const first = await get();
      expect(first.statusCode).toBe(200);
      const firstFirings = (first.json() as { alertFirings: { id: string; lastSeenAt: string }[] })
        .alertFirings;
      expect(firstFirings.length).toBeGreaterThan(0);

      const second = await get();
      expect(second.statusCode).toBe(200);
      const secondFirings = (
        second.json() as { alertFirings: { id: string; lastSeenAt: string }[] }
      ).alertFirings;

      // Same rows on the wire — the client cannot tell a throttled tick from a reconciled one.
      expect(secondFirings.map((f) => f.id)).toEqual(firstFirings.map((f) => f.id));
      // …but `last_seen_at` was NOT re-stamped, which is the observable proof the WRITE was
      // skipped. Under the pre-15.4 behaviour every tick re-stamped it.
      expect(secondFirings.map((f) => f.lastSeenAt)).toEqual(firstFirings.map((f) => f.lastSeenAt));
    } finally {
      await throttled.close();
    }
  });
});
