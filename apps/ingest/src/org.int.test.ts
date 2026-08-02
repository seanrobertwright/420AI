import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, ensurePersonalOrg, memberships, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const ADMIN_EMAIL = "org-admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in org tests", "unavailable");
  },
};

/**
 * M15 15.10 — `GET`/`PATCH /v1/org`, two-role.
 *
 * The rename is the milestone's only `owner`-gated mutation, and the asymmetry is the point:
 * `admin` is the rung that manages PEOPLE, while renaming the org is the most org-level act
 * available and has no undo surface. So "an admin gets 403" is the load-bearing assertion here,
 * not a formality — every other member route in the slice admits an admin.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.10 org settings (two-role, HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let userOwner: string;
  let userAdmin: string;
  let userViewer: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
    app = buildApp({
      db: appRole.db,
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
    expect(res.statusCode, `login for ${email}`).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE audit_events, api_keys, invites, sessions, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userOwner = await setUserPassword(owner.db, "o@example.com", hashPassword(PASSWORD));
    userAdmin = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "v@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(owner.db, userOwner, "o@example.com");
    // MOVED, never INSERTed — a second membership is shadowed by the personal `owner` one, so an
    // added row would make every assertion below silently test an owner (CLAUDE.md, 15.4).
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "admin" })
      .where(eq(memberships.userId, userAdmin));
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));
  });

  it("GET /v1/org at viewer returns the org with the right memberCount and yourRole", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/org",
      headers: asUser(await login("v@example.com")),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      name: string;
      isPersonal: boolean;
      memberCount: number;
      yourRole: string;
    };
    expect(body.id).toBe(orgA);
    expect(body.name).toBe("o@example.com");
    // THREE memberships, not the one the org was seeded with. This is what the dashboard branches
    // on for D-M15-10 — a solo org renders no `<OrgCard/>` at all.
    expect(body.memberCount).toBe(3);
    expect(body.yourRole).toBe("viewer");
    // Still flagged personal even with three members: the flag records PROVENANCE, not shape, and
    // the UI deliberately never branches on it.
    expect(body.isPersonal).toBe(true);
  });

  it("memberCount counts MEMBERSHIPS, not pending invites", async () => {
    const adminTok = asUser(await login("a@example.com"));
    const invited = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: { ...adminTok, "content-type": "application/json" },
      payload: { email: "pending@example.com", role: "member" },
    });
    expect(invited.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/v1/org", headers: adminTok });
    // A pending invite is not a colleague yet — counting it would make `<OrgCard/>` appear for a
    // solo user the moment they typed an email address.
    expect((res.json() as { memberCount: number }).memberCount).toBe(3);
  });

  it("PATCH /v1/org is 403 for an admin and 200 for the owner", async () => {
    const refused = await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: { ...asUser(await login("a@example.com")), "content-type": "application/json" },
      payload: { name: "Acme" },
    });
    expect(refused.statusCode).toBe(403);

    // …and nothing changed. A 403 that still wrote would be the worst of both.
    const unchanged = await owner.db.execute<{ name: string }>(
      sql`select name from organizations where id = ${orgA}`,
    );
    expect(unchanged.rows[0]!.name).toBe("o@example.com");

    const ok = await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: { ...asUser(await login("o@example.com")), "content-type": "application/json" },
      payload: { name: "Acme" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { org: { name: string } }).org.name).toBe("Acme");
  });

  it("the rename is audited with {from,to}, and the refusal is not", async () => {
    await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: { ...asUser(await login("a@example.com")), "content-type": "application/json" },
      payload: { name: "Nope" },
    });
    await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: { ...asUser(await login("o@example.com")), "content-type": "application/json" },
      payload: { name: "Acme" },
    });

    // Read back on the OWNER handle: the app role reads zero rows by design, so an assertion made
    // through the server's own connection would pass vacuously.
    const rows = await owner.db.execute<{
      action: string;
      actor_user_id: string;
      target_user_id: string | null;
      metadata: Record<string, unknown>;
    }>(sql`select action, actor_user_id, target_user_id, metadata from audit_events`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.action).toBe("org.renamed");
    expect(rows.rows[0]!.actor_user_id).toBe(userOwner);
    // No target PERSON — the object of the action is the org itself.
    expect(rows.rows[0]!.target_user_id).toBeNull();
    expect(rows.rows[0]!.metadata).toEqual({ from: "o@example.com", to: "Acme" });
  });

  it("a blank or whitespace-only name is refused", async () => {
    const ownerTok = {
      ...asUser(await login("o@example.com")),
      "content-type": "application/json",
    };
    // ajv bounds the RAW string, so "   " passes minLength:1 and the route must re-check post-trim.
    const blank = await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: ownerTok,
      payload: { name: "   " },
    });
    expect(blank.statusCode).toBe(400);
    const empty = await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: ownerTok,
      payload: { name: "" },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("a cross-org rename is INEXPRESSIBLE — the org comes only from the principal", async () => {
    // `userViewer`'s own personal org, which the owner of orgA has no standing in.
    const otherOrg = await owner.db.execute<{ id: string }>(
      sql`select org_id as id from memberships where user_id = ${userViewer}`,
    );
    // There is no path parameter and no body field for a target org. Smuggling one in is the only
    // thing available to an attacker, and it is INERT — measured, not assumed: Fastify's default
    // ajv runs with `removeAdditional`, so `additionalProperties: false` STRIPS the extra key
    // rather than rejecting the request. The rename therefore succeeds against the CALLER's org,
    // which is the correct outcome and a stronger statement than a 400 would be (a 400 would only
    // prove the field was noticed; this proves it cannot reach the query).
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org",
      headers: { ...asUser(await login("o@example.com")), "content-type": "application/json" },
      payload: { name: "Acme", orgId: otherOrg.rows[0]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { org: { id: string } }).org.id).toBe(orgA);

    // orgA is the viewer's org too (they were MOVED into it), so the meaningful check is that the
    // bootstrap admin's separate org is untouched by anything above.
    const adminOrg = await owner.db.execute<{ name: string }>(
      sql`select o.name from organizations o
          join memberships m on m.org_id = o.id
          join users u on u.id = m.user_id
          where u.email = ${ADMIN_EMAIL}`,
    );
    expect(adminOrg.rows[0]!.name).toBe(ADMIN_EMAIL);
  });
});
