import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  apiKeys,
  confirmTotp,
  createDb,
  ensurePersonalOrg,
  memberships,
  setUserPassword,
  upsertUnconfirmedTotp,
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
const ADMIN_EMAIL = "bootstrap@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse-battery";
const TOTP_SECRET = Buffer.from("12345678901234567890", "ascii");

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in api key tests", "unavailable");
  },
};

/**
 * M15 15.9 — THE SLICE'S PRIMARY PROOF. A TWO-ROLE, MULTI-USER, HTTP suite for API keys (D-M15-7),
 * built on `sessions.int.test.ts`'s harness.
 *
 * The split with `packages/db/src/repositories/api-keys.int.test.ts` is deliberate (the 15.8
 * precedent): that file proves the STORAGE AND REVOCATION MECHANISMS and the pre-context read under
 * a non-owner role; THIS file proves the PRIMARY DEFENCE — the route gates, the ceiling, the floor,
 * re-auth, and the end-to-end flows.
 *
 * FOUR FAILURE MODES THIS FILE EXISTS TO EXCLUDE, each of which reports nothing anywhere:
 *
 *   1. A key that works but is never CAPPED — mint above your own rung and the ladder is decorative.
 *   2. A key whose role is FROZEN AT MINT — demote its owner and it keeps the old rung silently.
 *      This is the one an ordinary "does the key work?" test cannot see, because the key does work;
 *      it just works at the wrong level. See "the FLOOR" below.
 *   3. A revoked key that still authenticates — a 200 with no error and no log, the same silhouette
 *      as 15.3's dead alert delivery and 15.4's silent `DELETE 0`.
 *   4. The plaintext token LEAKING into a later response, which no type or gate would catch.
 *
 * ROLE IDENTITY IS NOT RE-ASSERTED HERE: the app is built on `appRole.db` and the repository suite
 * asserts `is_superuser = off` / `rolbypassrls = false` on that same handle as its first test. What
 * this file adds is that the SERVER, connected as that role, can complete the whole flow.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.9 API keys (two-role, HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let userOwner: string;
  let userMember: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as
    app = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      reconcileThrottleMs: 0,
      // 0 = touch on EVERY key-authenticated request. The only way to observe a throttled
      // fire-and-forget write at all; the throttle's own logic is unit-tested in api-keys.test.ts.
      apiKeyTouchThrottleMs: 0,
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

  beforeEach(async () => {
    // `api_keys` is deliberately absent from this list: it references `users`, so CASCADE clears it
    // without being named — the same reason `sessions` is absent.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    userMember = await setUserPassword(owner.db, "member@example.com", hashPassword(PASSWORD));

    // CLAUDE.md's 15.4 seeding rule: `setUserPassword` calls `ensurePersonalOrg`, so each user
    // already holds an `owner` membership in their own org, and `findPrincipalByEmail` resolves the
    // FIRST membership by (created_at, id). The colleague is therefore MOVED into org A rather than
    // given a SECOND membership — an inserted row would be shadowed and every assertion about "a
    // member" would silently be testing an owner.
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "member" })
      .where(eq(memberships.userId, userMember));
  });

  async function login(email: string, password: string = PASSWORD): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
    expect(res.statusCode, `login for ${email}: ${res.body}`).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...asUser(token), "content-type": "application/json" });

  interface WireApiKey {
    id: string;
    name: string;
    role: string | null;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }

  /** Mint a key over a session, asserting success. Returns the wire row AND the one-time token. */
  async function mint(
    sessionToken: string,
    body: Record<string, unknown> = { name: "desktop" },
  ): Promise<{ apiKey: WireApiKey; token: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: json(sessionToken),
      payload: { currentPassword: PASSWORD, ...body },
    });
    expect(res.statusCode, `mint: ${res.body}`).toBe(201);
    return res.json() as { apiKey: WireApiKey; token: string };
  }

  /** `GET /v1/auth/me`'s status for any bearer — the one probe most assertions here use. */
  async function meStatus(token: string): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    return res.statusCode;
  }

  /**
   * OBSERVE THE EFFECTIVE ROLE BEHAVIOURALLY, via two gates at different rungs, because no route
   * REPORTS it — `GET /v1/auth/me` returns `{ email }` only, and deliberately so.
   *
   * That is the right way round for this suite anyway: the claim under test is "the key is
   * AUTHORIZED at the lower rung", and a route gate is what actually decides that. A reported
   * string could agree with the ladder while the gates disagreed.
   *
   * `GET /v1/invites` gates at `admin` and `GET /v1/monitor` at `viewer`; both are READS, so a role
   * probe never mutates the fixture it is measuring.
   */
  async function rungOf(token: string): Promise<"admin+" | "viewer+" | "none"> {
    if ((await app.inject({ url: "/v1/invites", headers: asUser(token) })).statusCode === 200) {
      return "admin+";
    }
    if ((await app.inject({ url: "/v1/monitor", headers: asUser(token) })).statusCode === 200) {
      return "viewer+";
    }
    return "none";
  }

  // ── 1. THE POSITIVE ASSERTIONS, before any negative one ────────────────────────────────────
  //
  // A gate that rejects EVERYTHING is indistinguishable from a correct gate if the file only ever
  // asserts 401s. Every negative below is preceded by a positive that would fail first.

  it("mints a key, returns the plaintext EXACTLY ONCE, and the key authenticates", async () => {
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session, { name: "desktop" });

    expect(token).toMatch(/^k420_/);
    expect(token).toHaveLength(48);
    expect(apiKey.name).toBe("desktop");
    expect(apiKey.role).toBeNull(); // absent ⇒ inherit (D-15.9-4)
    expect(apiKey.expiresAt).toBeNull(); // absent ⇒ never (D-15.9-8)

    // THE POINT OF THE TIER: the key is a bearer on its own, with no session anywhere.
    expect(await meStatus(token)).toBe(200);
  });

  it("a key acts as its owner's principal — same user, same rung", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    // The key resolves to the OWNER's identity, not to some service principal — which is the
    // attributability `ADMIN_TOKEN` never had (every holder of it resolved to the bootstrap admin).
    expect((res.json() as { email: string }).email).toBe("owner@example.com");
    // And a role-less key inherits the owner's rung exactly (D-15.9-4).
    expect(await rungOf(token)).toBe("admin+");
    // Org membership is what carries the org: the key row holds no `org_id` at all (D-15.9-1), so
    // this read is scoped by the SAME membership a session would resolve.
    const invites = await app.inject({ url: "/v1/invites", headers: asUser(token) });
    expect(invites.statusCode).toBe(200);
    expect(orgA).toBeTruthy();
  });

  it("lists the caller's keys and NEVER leaks the hash or the plaintext", async () => {
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session, { name: "desktop" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/api-keys",
      headers: asUser(session),
    });
    expect(res.statusCode).toBe(200);
    const listed = (res.json() as { apiKeys: WireApiKey[] }).apiKeys;
    expect(listed.map((k) => k.id)).toEqual([apiKey.id]);

    // The mint response is the ONLY place the plaintext ever appears. Asserted against the RAW
    // BODY, not the parsed object, so a token smuggled into any field — or into an error message —
    // is caught. `token_hash` likewise: nothing strips extra properties on the wire (CLAUDE.md
    // 15.1), so the repository's explicit column list is the whole enforcement.
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain("tokenHash");
    expect(res.body).not.toContain("token_hash");
  });

  it("a key can list and revoke keys itself, but the plaintext is unrecoverable", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/api-keys",
      headers: asUser(token),
    });
    expect(res.statusCode).toBe(200);
    // Its own row is listed — and still without the credential. A lost token is re-minted, never
    // recovered, because only the sha256 was ever stored (D-15.9-2).
    expect(res.body).not.toContain(token);
  });

  // ── 2. THE CEILING (D-15.9-4 / D-15.5-11) ──────────────────────────────────────────────────

  it("a member may mint at or below their own rung", async () => {
    // POSITIVE FIRST: the ceiling must not be a blanket refusal.
    const session = await login("member@example.com");
    const atRung = await mint(session, { name: "same rung", role: "member" });
    expect(atRung.apiKey.role).toBe("member");
    const below = await mint(session, { name: "below", role: "viewer" });
    expect(below.apiKey.role).toBe("viewer");
  });

  it("a member may NOT mint an admin or owner key (403)", async () => {
    const session = await login("member@example.com");
    for (const role of ["admin", "owner"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/api-keys",
        headers: json(session),
        payload: { name: "escalation", role, currentPassword: PASSWORD },
      });
      expect(res.statusCode, `minting ${role} as a member: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ error: "cannot grant a role above your own" });
    }
    // And nothing was written — a 403 that still inserted the row would be the worst outcome.
    const rows = await owner.db.select().from(apiKeys).where(eq(apiKeys.userId, userMember));
    expect(rows).toHaveLength(0);
  });

  it("a key minted BELOW its owner's rung acts at the key's rung, not the owner's", async () => {
    // The ceiling half of the `min`: an owner issuing a `viewer` key for a reporting script must
    // not accidentally hand out ownership of the deployment.
    const session = await login("owner@example.com");
    const { token } = await mint(session, { name: "reports", role: "viewer" });
    // The owner's own session is admin+; the key it minted is not. Both assertions matter — the
    // second alone would pass for a key that authenticated as nobody.
    expect(await rungOf(session)).toBe("admin+");
    expect(await rungOf(token)).toBe("viewer+");
  });

  // ── 3. THE FLOOR — the assertion that proves the role is RE-DERIVED, not frozen ─────────────

  /**
   * THE TEST THIS SLICE MOST NEEDS, and the one a "does the key work?" suite would never contain.
   *
   * A mint-time-only cap passes every other test in this file: the key works, it is capped at
   * issuance, it revokes. What it does NOT do is notice that its owner has been demoted — so an
   * ex-admin's key keeps administering the org until somebody remembers it exists. D-15.9-4 makes
   * the effective role a `min` re-derived on every request precisely so this cannot happen, and
   * this is the only assertion that can tell the two designs apart.
   */
  it("a key DROPS to the lower rung when its owner is demoted, with no rotation", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session, { name: "desktop", role: "admin" });

    // POSITIVE FIRST: at full rung the key really can act as an admin.
    expect(await rungOf(token), "an admin key must reach an admin-gated route").toBe("admin+");

    // Demote the OWNER. The key row is untouched — its stored role is still "admin".
    await owner.db
      .update(memberships)
      .set({ role: "viewer" })
      .where(eq(memberships.userId, userOwner));
    const stored = await owner.db.select().from(apiKeys).where(eq(apiKeys.userId, userOwner));
    expect(stored[0]!.role, "the key row itself must NOT have been rewritten").toBe("admin");

    // THE ASSERTION: the very next request is a viewer. Under a mint-time cap it would still be
    // an admin, and this test is the only thing in the repo that would notice.
    expect(await rungOf(token), "a demoted owner's admin key must lose admin").toBe("viewer+");
  });

  it("REJECTS a key whose stored role is not a real role (401), rather than clamping it", async () => {
    // D-15.9-4: `role` is TEXT with no CHECK, so a hand-edited row can hold anything. Failing
    // closed is the same direction `hasRole` fails; clamping to `viewer` would be a quiet "it
    // works" that hides a corrupt row.
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session, { name: "desktop", role: "admin" });
    expect(await meStatus(token)).toBe(200); // positive first
    await owner.db.update(apiKeys).set({ role: "superuser" }).where(eq(apiKeys.id, apiKey.id));
    expect(await meStatus(token)).toBe(401);
  });

  // ── 4. RE-AUTHENTICATION (D-15.9-6) ────────────────────────────────────────────────────────

  it("minting REQUIRES the current password; a wrong or missing one is 401", async () => {
    const session = await login("owner@example.com");
    for (const payload of [{ name: "k" }, { name: "k", currentPassword: "wrong-password" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/api-keys",
        headers: json(session),
        payload,
      });
      expect(res.statusCode, `mint with ${JSON.stringify(payload)}: ${res.body}`).toBe(401);
      expect(res.json()).toMatchObject({ reason: "password_required" });
    }
    // Nothing was minted by a failed re-auth.
    const rows = await owner.db.select().from(apiKeys).where(eq(apiKeys.userId, userOwner));
    expect(rows).toHaveLength(0);
  });

  /**
   * REVOCATION MUST NEVER BE HARDER THAN MINTING. A re-auth prompt on the "undo" is a prompt in the
   * middle of an incident response — so listing and revoking are deliberately ungated, and this
   * asserts that rather than leaving it to the reader to notice the absence.
   */
  it("listing and revoking need NO re-authentication", async () => {
    const session = await login("owner@example.com");
    const { apiKey } = await mint(session);
    expect(
      (await app.inject({ url: "/v1/auth/api-keys", headers: asUser(session) })).statusCode,
    ).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/auth/api-keys/${apiKey.id}`,
      headers: asUser(session),
    });
    expect(del.statusCode).toBe(204);
  });

  /**
   * A KEY MUST NOT BE ABLE TO MINT ANOTHER KEY WITHOUT THE PASSWORD. This is not merely inherited
   * behaviour: a key caller has `sessionId === null`, so if the SSO branch of the re-auth gate were
   * ever reached it would have no session to age-check. It fails closed on both branches, and the
   * password branch is the one that applies to a password-holding account.
   */
  it("a key cannot mint a second key without the password (no privilege bootstrapping)", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: json(token),
      payload: { name: "spawned" },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 5. REVOCATION AND EXPIRY ───────────────────────────────────────────────────────────────

  it("a REVOKED key 401s on its very next request", async () => {
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session);
    expect(await meStatus(token)).toBe(200); // positive first

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/auth/api-keys/${apiKey.id}`,
      headers: asUser(session),
    });
    expect(del.statusCode).toBe(204);
    expect(await meStatus(token)).toBe(401);
    // And it drops out of the list — a revoked key is not something you can "re-revoke".
    const list = await app.inject({ url: "/v1/auth/api-keys", headers: asUser(session) });
    expect((list.json() as { apiKeys: WireApiKey[] }).apiKeys).toHaveLength(0);
  });

  it("an EXPIRED key 401s, and expiresInDays is honoured", async () => {
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session, { name: "short", expiresInDays: 1 });
    expect(apiKey.expiresAt).not.toBeNull();
    expect(await meStatus(token)).toBe(200); // positive first
    // Move the deadline into the past rather than waiting a day.
    await owner.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(apiKeys.id, apiKey.id));
    expect(await meStatus(token)).toBe(401);
  });

  it("revoking someone else's key is 404, not 403 (no enumeration oracle)", async () => {
    const ownerSession = await login("owner@example.com");
    const memberSession = await login("member@example.com");
    const { apiKey, token } = await mint(ownerSession);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/auth/api-keys/${apiKey.id}`,
      headers: asUser(memberSession),
    });
    // 404 — telling a caller that an id exists but is not theirs is exactly the oracle the
    // sessions route and the reset route are both shaped to avoid.
    expect(res.statusCode).toBe(404);
    // And it is genuinely still alive, not merely reported as absent.
    expect(await meStatus(token)).toBe(200);
  });

  it("a malformed key id is 400, never a Postgres uuid-cast 500", async () => {
    const session = await login("owner@example.com");
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/auth/api-keys/not-a-uuid",
      headers: asUser(session),
    });
    expect(res.statusCode).toBe(400);
  });

  it("an unknown but well-formed k420_ token is 401, indistinguishable from revoked", async () => {
    // The three rejection reasons collapse on purpose — distinguishing them would tell an attacker
    // whether a guessed value exists.
    expect(await meStatus(`k420_${"a".repeat(43)}`)).toBe(401);
  });

  // ── 6. MEMBER REMOVAL (D-15.9-9) ───────────────────────────────────────────────────────────

  it("removing a member REVOKES their API keys in the same transaction", async () => {
    const ownerSession = await login("owner@example.com");
    const memberSession = await login("member@example.com");
    const { token } = await mint(memberSession, { name: "colleague's laptop" });
    expect(await meStatus(token)).toBe(200); // positive first

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userMember}`,
      headers: asUser(ownerSession),
    });
    expect(removed.statusCode, `remove member: ${removed.body}`).toBe(204);

    expect(await meStatus(token)).toBe(401);
    // THE DISCRIMINATOR. The 401 above would happen anyway today, carried by the missing
    // MEMBERSHIP (`findPrincipalByUserId`'s innerJoin resolves nothing) — the same accidental
    // mechanism 15.6 replaced for sessions, and one that evaporates the moment 15.10 ships
    // multi-org users. So assert the ROW was actually stamped, which is the designed guarantee.
    const rows = await owner.db.select().from(apiKeys).where(eq(apiKeys.userId, userMember));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt, "the key row itself must be revoked, not merely orphaned").not.toBe(
      null,
    );
  });

  /**
   * THE OTHER HALF OF D-15.9-9, and a deliberate asymmetry rather than an oversight. A key is not
   * derived from the password, and revoking on a routine rotation would silently break the desktop
   * app and every scheduled script — a worse outcome than the threat it addresses. Asserted so a
   * later reader does not "fix" the missing revoke into existence.
   */
  it("changing a password does NOT revoke API keys", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: json(session),
      payload: { currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" },
    });
    expect(res.statusCode, `change password: ${res.body}`).toBe(204);
    expect(await meStatus(token), "a key must survive its owner's password rotation").toBe(200);
  });

  // ── 7. MFA (D-15.9-5) ──────────────────────────────────────────────────────────────────────

  /**
   * A KEY IS NEVER MFA-GATED. MFA is enforced at LOGIN, and a key can only exist because an
   * already-authenticated — and, if enrolled, already-MFA'd — session minted it. Re-challenging on
   * every machine request would make the tier unusable for exactly the headless clients it exists
   * for, while adding nothing: the second factor was already presented to create the key.
   */
  it("a key keeps working after its owner enrols in MFA", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    expect(await meStatus(token)).toBe(200); // positive first

    // Enrol + confirm directly, so the test does not depend on the TOTP clock.
    await upsertUnconfirmedTotp(owner.db, userOwner, TOTP_SECRET);
    expect(await confirmTotp(owner.db, userOwner, 1)).toBe(true);

    // A password LOGIN now returns a challenge rather than a session...
    const relogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "owner@example.com", password: PASSWORD },
    });
    expect(relogin.json()).toHaveProperty("challenge");
    // ...while the key authenticates unchanged.
    expect(await meStatus(token), "an API key must not be MFA-gated (D-15.9-5)").toBe(200);
  });

  // ── 8. last_used_at (D-15.9-7) ─────────────────────────────────────────────────────────────

  it("stamps last_used_at when the key authenticates (throttle injected at 0)", async () => {
    const session = await login("owner@example.com");
    const { apiKey, token } = await mint(session);
    const before = await owner.db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(before[0]!.lastUsedAt, "a fresh key has never been used").toBeNull();

    expect(await meStatus(token)).toBe(200);
    // The write is FIRE-AND-FORGET, so it is not ordered against the response. Poll briefly rather
    // than sleeping a fixed interval — a bare assertion here would be flaky by construction.
    let stamped: Date | null = null;
    for (let i = 0; i < 40 && stamped === null; i++) {
      const rows = await owner.db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
      stamped = rows[0]!.lastUsedAt;
      if (stamped === null) await new Promise((r) => setTimeout(r, 25));
    }
    expect(stamped, "last_used_at must be stamped by an authenticated key request").not.toBeNull();
  });

  // ── 9. TIER ISOLATION ──────────────────────────────────────────────────────────────────────

  it("a session token still works alongside keys — the tiers do not interfere", async () => {
    const session = await login("owner@example.com");
    const { token } = await mint(session);
    expect(await meStatus(session)).toBe(200);
    expect(await meStatus(token)).toBe(200);
    // And revoking the SESSION leaves the key alone: they are independent credentials, which is
    // the entire reason for issuing one per machine.
    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(session),
    });
    expect(out.statusCode).toBe(200);
    expect(await meStatus(session)).toBe(401);
    expect(await meStatus(token)).toBe(200);
  });

  it("all three routes 401 with no Authorization header at all", async () => {
    // The POST carries a VALID body on purpose. Fastify runs body validation BEFORE the handler,
    // so an empty payload would 400 before the auth gate is ever reached — a green test that
    // proved schema validation works and said nothing at all about authentication.
    const unauth = [
      { method: "GET" as const, url: "/v1/auth/api-keys" },
      {
        method: "POST" as const,
        url: "/v1/auth/api-keys",
        headers: { "content-type": "application/json" },
        payload: { name: "unauthenticated", currentPassword: PASSWORD },
      },
      { method: "DELETE" as const, url: "/v1/auth/api-keys/11111111-2222-3333-4444-555555555555" },
    ];
    for (const req of unauth) {
      const res = await app.inject(req);
      expect(res.statusCode, `${req.method} ${req.url} with no bearer`).toBe(401);
    }
  });

  // ── 10. THE SSE STREAM — revocation must reach an ALREADY-OPEN socket ───────────────────────

  /**
   * THE CORRECTNESS RISK OF THIS SLICE, asserted rather than reasoned about.
   *
   * `GET /v1/monitor/stream` calls `reply.hijack()` and then serves the org's live snapshot on a
   * timer, so its `resolvePrincipal` gate ran ONCE, at connect time. 15.6 closed that for sessions.
   * The comment justifying the remaining skip said the only credential without a session was
   * `ADMIN_TOKEN`, which was "un-revocable by construction" — true of that tier and FALSE of a key.
   * Inheriting the skip would have re-opened the identical hole one tier over: revoke a key, and
   * the desktop app's open stream keeps delivering frames while every other route 401s.
   *
   * MUTATION PROOF: delete the `isApiKeyLive` probe from `routes/monitor.ts` and this test fails
   * while the rest of this file stays green — which is what makes it a test of the STREAM's
   * re-check rather than of revocation in general.
   */
  it("an OPEN SSE stream dies when its API key is revoked mid-flight", async () => {
    const streamApp = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      monitorStreamIntervalMs: 50,
      reconcileThrottleMs: 0,
      apiKeyTouchThrottleMs: 0,
      logger: false,
    });
    await streamApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (streamApp.server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      const session = await login("owner@example.com");
      const { apiKey, token } = await mint(session);
      const res = await fetch(`http://127.0.0.1:${port}/v1/monitor/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(res.status, "the stream must open for a live key").toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      /** Read frames until `match` appears, or give up after `budget` reads. */
      const readUntil = async (match: RegExp, budget = 40): Promise<string> => {
        let buf = "";
        for (let i = 0; i < budget; i++) {
          const { value, done } = await reader.read();
          if (value) buf += decoder.decode(value, { stream: true });
          if (match.test(buf)) return buf;
          if (done) break;
        }
        return buf;
      };

      // POSITIVE FIRST: the stream really is delivering data before we take the key away.
      expect(await readUntil(/^data: /m), "the stream must deliver a snapshot first").toMatch(
        /^data: /m,
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/v1/auth/api-keys/${apiKey.id}`,
        headers: asUser(session),
      });
      expect(del.statusCode).toBe(204);

      // THE ASSERTION. Without the per-tick probe this read produces `data:` frames forever.
      const after = await readUntil(/event: error/);
      expect(after, "a revoked key's stream must be terminated, not kept alive").toContain(
        "event: error",
      );
      expect(after).toContain("api key revoked");
    } finally {
      controller.abort();
      await streamApp.close();
    }
  });
});
