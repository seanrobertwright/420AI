import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createDb,
  ensurePersonalOrg,
  memberships,
  setUserPassword,
  type AuditEventInput,
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
const ADMIN_EMAIL = "audit-admin@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in audit tests", "unavailable");
  },
};

/**
 * The break-glass row shape. An index signature rather than a plain interface because
 * `db.execute<T>` constrains `T` to `Record<string, unknown>` — an interface has no implicit one.
 */
interface AuditRow {
  [key: string]: unknown;
  action: string;
  actor_user_id: string;
  actor_email: string;
  target_user_id: string | null;
  target_email: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * M15 15.10 — EVERY AUDITED ACTION, DRIVEN THROUGH ITS REAL ENDPOINT.
 *
 * TWO ROLES, and both halves of the split matter for a reason specific to this table:
 *   - the SERVER is built on `appRole` (DATABASE_URL_TEST_APP), so every audit insert this file
 *     provokes really does run under the non-bypassing role the append-only policy is written for;
 *   - every audit ASSERTION reads back on the OWNER handle, because THE APP ROLE READS ZERO ROWS BY
 *     DESIGN. An assertion made through the app handle would pass vacuously against an empty result
 *     — the exact "green and enforcing nothing" shape this repo has been burned by three times.
 *
 * The three discriminating cases at the end are what make this more than a checklist: a REFUSED
 * mutation writes nothing, a `viewer` revoking their own key DOES write (proving no role policy
 * blocks the append), and `member.removed` carries the revoke counts.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.10 audit trail (two-role, HTTP)", () => {
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

  /** Read the audit trail the ONLY way it can be read: as the owner (D-M15-7 break-glass). */
  async function auditRows(): Promise<AuditRow[]> {
    const r = await owner.db.execute<AuditRow>(
      sql`select action, actor_user_id, actor_email, target_user_id, target_email, metadata
          from audit_events order by created_at, action`,
    );
    return r.rows;
  }

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE audit_events, api_keys, invites, mfa_recovery_codes, totp_credentials, sessions, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userOwner = await setUserPassword(owner.db, "o@example.com", hashPassword(PASSWORD));
    userAdmin = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "v@example.com", hashPassword(PASSWORD));

    // ONE org, THREE rungs. The non-owners are MOVED rather than given a second membership:
    // `setUserPassword` auto-creates a personal `owner` membership via `ensurePersonalOrg`, and
    // `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)` — so an INSERTed
    // second one is silently shadowed and every role assertion here would in fact test an owner.
    orgA = await ensurePersonalOrg(owner.db, userOwner, "o@example.com");
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "admin" })
      .where(eq(memberships.userId, userAdmin));
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));
  });

  // ── the member/invite lifecycle ─────────────────────────────────────────────────────────────

  it("POST /v1/members/invite writes exactly one member.invited with a NULL target_user_id", async () => {
    const admin = asUser(await login("a@example.com"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: { ...admin, "content-type": "application/json" },
      payload: { email: "new@example.com", role: "member" },
    });
    expect(res.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("member.invited");
    expect(rows[0]!.actor_user_id).toBe(userAdmin);
    expect(rows[0]!.actor_email).toBe("a@example.com");
    // THE CASE A NORMALIZED-ONLY SCHEMA COULD NOT RECORD: an invited address has no `users` row
    // yet, so the denormalized email is the only identification there is.
    expect(rows[0]!.target_user_id).toBeNull();
    expect(rows[0]!.target_email).toBe("new@example.com");
    expect(rows[0]!.metadata).toEqual({ role: "member" });
  });

  it("DELETE /v1/invites/:id writes member.invite_revoked with the invite id", async () => {
    const admin = asUser(await login("a@example.com"));
    const created = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: { ...admin, "content-type": "application/json" },
      payload: { email: "new@example.com", role: "member" },
    });
    const inviteId = (created.json() as { invite: { id: string } }).invite.id;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/invites/${inviteId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(204);

    const revoked = (await auditRows()).filter((r) => r.action === "member.invite_revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.metadata).toEqual({ inviteId });
    // Deliberately null: widening `revokeInvite`'s signature for a log field is the wrong trade,
    // and the invite id identifies the row for the break-glass reader.
    expect(revoked[0]!.target_email).toBeNull();
  });

  it("POST /v1/auth/invites/accept writes member.joined with actor === target", async () => {
    const admin = asUser(await login("a@example.com"));
    const created = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: { ...admin, "content-type": "application/json" },
      payload: { email: "joiner@example.com", role: "member" },
    });
    const token = (created.json() as { token: string }).token;

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/invites/accept",
      headers: { "content-type": "application/json" },
      payload: { token, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);

    const joined = (await auditRows()).filter((r) => r.action === "member.joined");
    expect(joined).toHaveLength(1);
    // AN INVITE IS REDEEMED BY ITS RECIPIENT — the actor and the target being the same person is
    // correct rather than redundant, so both "what did they do" and "what happened to them" find it.
    expect(joined[0]!.actor_email).toBe("joiner@example.com");
    expect(joined[0]!.target_email).toBe("joiner@example.com");
    expect(joined[0]!.actor_user_id).toBe(joined[0]!.target_user_id);
    expect(joined[0]!.metadata).toEqual({ role: "member" });
  });

  it("PATCH /v1/members/:userId writes member.role_changed with {from,to}", async () => {
    const ownerTok = asUser(await login("o@example.com"));
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: { ...ownerTok, "content-type": "application/json" },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("member.role_changed");
    expect(rows[0]!.actor_user_id).toBe(userOwner);
    expect(rows[0]!.target_user_id).toBe(userViewer);
    expect(rows[0]!.target_email).toBe("v@example.com");
    // `from` is the PRE-change rung, captured before the update lands.
    expect(rows[0]!.metadata).toEqual({ from: "viewer", to: "member" });
  });

  it("DELETE /v1/members/:userId writes member.removed WITH the revoke counts", async () => {
    // Give the target a live session and a live key, so both counts are non-zero and the assertion
    // discriminates. A "removed 0 keys" row and a "removed 4 keys" row are materially different
    // entries on an incident timeline.
    const viewerTok = await login("v@example.com");
    const mint = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: { ...asUser(viewerTok), "content-type": "application/json" },
      payload: { name: "victim-key", currentPassword: PASSWORD },
    });
    expect(mint.statusCode).toBe(201);

    const ownerTok = asUser(await login("o@example.com"));
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userViewer}`,
      headers: ownerTok,
    });
    expect(res.statusCode).toBe(204);

    const removed = (await auditRows()).filter((r) => r.action === "member.removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.target_user_id).toBe(userViewer);
    expect(removed[0]!.target_email).toBe("v@example.com");
    expect(removed[0]!.metadata).toMatchObject({ role: "viewer", keysRevoked: 1 });
    expect((removed[0]!.metadata as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThan(
      0,
    );
  });

  it("DELETE /v1/members/:userId/mfa writes member.mfa_reset", async () => {
    const ownerTok = asUser(await login("o@example.com"));
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userViewer}/mfa`,
      headers: ownerTok,
    });
    expect(res.statusCode).toBe(204);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("member.mfa_reset");
    expect(rows[0]!.actor_user_id).toBe(userOwner);
    expect(rows[0]!.target_user_id).toBe(userViewer);
    expect(rows[0]!.metadata).toEqual({ role: "viewer" });
  });

  // ── the API-key tier: audited from a route with NO org context at all ────────────────────────

  it("minting and revoking a key write api_key.minted / api_key.revoked", async () => {
    const tok = await login("o@example.com");
    const mint = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: { ...asUser(tok), "content-type": "application/json" },
      payload: { name: "laptop", currentPassword: PASSWORD, expiresInDays: 30 },
    });
    expect(mint.statusCode).toBe(201);
    const keyId = (mint.json() as { apiKey: { id: string } }).apiKey.id;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/auth/api-keys/${keyId}`,
      headers: asUser(tok),
    });
    expect(del.statusCode).toBe(204);

    const rows = await auditRows();
    expect(rows.map((r) => r.action).sort()).toEqual(["api_key.minted", "api_key.revoked"]);
    const minted = rows.find((r) => r.action === "api_key.minted")!;
    expect(minted.metadata).toMatchObject({ keyName: "laptop", role: null });
    // NEVER THE PLAINTEXT OR A HASH. The token exists exactly once, in the mint response; a copy
    // here would be permanent in the one table the application cannot delete from.
    const mintedToken = (mint.json() as { token: string }).token;
    expect(JSON.stringify(rows)).not.toContain(mintedToken);
    expect(rows.find((r) => r.action === "api_key.revoked")!.metadata).toEqual({ keyId });
  });

  it("DELETE /v1/auth/api-keys audits api_key.revoked_all EVEN WHEN nothing was live", async () => {
    const tok = asUser(await login("o@example.com"));
    const res = await app.inject({ method: "DELETE", url: "/v1/auth/api-keys", headers: tok });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 0 });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    // "I pressed the panic button and there was nothing to kill" is a real, meaningful event: it
    // is the difference between a user who reacted and a user who did not.
    expect(rows[0]!.action).toBe("api_key.revoked_all");
    expect(rows[0]!.metadata).toEqual({ revoked: 0 });
  });

  // ── the three discriminating cases ───────────────────────────────────────────────────────────

  it("a VIEWER revoking their own key DOES produce a row (no role policy blocks the append)", async () => {
    const tok = await login("v@example.com");
    const mint = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: { ...asUser(tok), "content-type": "application/json" },
      payload: { name: "viewer-key", currentPassword: PASSWORD },
    });
    expect(mint.statusCode).toBe(201);
    const keyId = (mint.json() as { apiKey: { id: string } }).apiKey.id;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/auth/api-keys/${keyId}`,
      headers: asUser(tok),
    });
    expect(del.statusCode).toBe(204);

    // THE ASSERTION THAT RULES OUT THE 15.4 RESTRICTIVE ROLE POLICIES AS A DESIGN HERE. Under one,
    // a viewer's append would be a 500 on the one route a read-only account must always be able to
    // use — revocation must never be harder than minting.
    const rows = await auditRows();
    expect(rows.map((r) => r.action).sort()).toEqual(["api_key.minted", "api_key.revoked"]);
    for (const r of rows) expect(r.actor_user_id).toBe(userViewer);
  });

  it("a REFUSED mutation writes ZERO audit rows", async () => {
    const adminTok = asUser(await login("a@example.com"));

    // 403 — the 15.5 FLOOR: an admin may not act on an owner.
    const demote = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userOwner}`,
      headers: { ...adminTok, "content-type": "application/json" },
      payload: { role: "viewer" },
    });
    expect(demote.statusCode).toBe(403);

    // 403 — and the MFA reset carries the same floor, which is the reason 15.8 refused to ship it.
    const reset = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userOwner}/mfa`,
      headers: adminTok,
    });
    expect(reset.statusCode).toBe(403);

    // 409 — the three-way invite rejection.
    const dupe = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: { ...adminTok, "content-type": "application/json" },
      payload: { email: "v@example.com", role: "member" },
    });
    expect(dupe.statusCode).toBe(409);

    // A refusal is not an event. Auditing them would make this a request log and bury the ten
    // actions that matter.
    expect(await auditRows()).toEqual([]);
  });

  it("the 403 MFA reset really did NOT clear the owner's second factor", async () => {
    // The zero-rows assertion above is necessary but not sufficient: it would also hold if the
    // route had done the work and merely failed to audit it. This checks the side effect directly.
    await owner.db.execute(
      // The ciphertext triple is never decrypted here — `clearMfa` only DELETEs — so opaque
      // placeholders are sufficient and avoid coupling this test to the encryption helper.
      sql`insert into totp_credentials (user_id, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
          values (${userOwner}, ${"ct"}, ${"iv"}, ${"tag"}, now())`,
    );
    const adminTok = asUser(await login("a@example.com"));
    const reset = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userOwner}/mfa`,
      headers: adminTok,
    });
    expect(reset.statusCode).toBe(403);

    const still = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from totp_credentials where user_id = ${userOwner}`,
    );
    expect(still.rows[0]!.n).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  // A compile-time assertion rather than a runtime one: `AuditEventInput["action"]` is the closed
  // set, so a typo anywhere above is a build failure, not an unqueryable row. Referenced here so
  // the import is not "unused" and the contract is visible in the suite that depends on it.
  it("the action type is closed", () => {
    const ok: AuditEventInput["action"] = "member.invited";
    expect(ok).toBe("member.invited");
  });
});
