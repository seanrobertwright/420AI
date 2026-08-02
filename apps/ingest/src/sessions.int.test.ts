import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, ensurePersonalOrg, memberships, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { verifySession } from "./session.js";
import type { Mailer } from "./delivery/mailer.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
/**
 * M15 15.9 (D-M15-7) — the MACHINE-tier bearer is now a real API KEY, minted per test in the
 * fixture below. `let`, not `const`: `api_keys` carries an FK to `users`, so this suite's TRUNCATE
 * deletes the key with its owner and it must be re-minted after every reset.
 *
 * The NAME is kept so the tests that assert "the machine tier still works here" keep reading as
 * tests of that tier. What changed is the credential behind it: `ADMIN_TOKEN` was one shared,
 * un-attributable, un-revocable string; this is a per-user key, capped at its owner's rung.
 */
let SERVICE_TOKEN: string;
const ADMIN_EMAIL = "bootstrap@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-passphrase";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in session tests", "unavailable");
  },
};

/**
 * M15 15.6 — THE SLICE'S PROOF. A TWO-ROLE, MULTI-USER, HTTP suite for stateful sessions
 * (D-M15-12), built on `identity.int.test.ts`'s harness.
 *
 * WHY THE USUAL 15.3/15.5 SHAPE DOES NOT TRANSFER. Those slices proved their claims by dropping an
 * RLS policy and watching tests fail. That works when the mechanism under test IS a policy.
 * `sessions` has no policy at all (D-15.6-3) — there is nothing to drop. So the failure mode this
 * file must exclude is a different and nastier one:
 *
 *   A REVOKED SESSION THAT STILL WORKS REPORTS NOTHING ANYWHERE. No error, no log, a 200 response
 *   — and every EXISTING test in the repo stays green, because every existing test uses a freshly
 *   minted token, which is live by construction.
 *
 * That is the same silhouette as 15.3's dead alert delivery (`bypassed ≠ enforced`) and 15.4's
 * silent `DELETE 0`. Four assertions exclude it, and a suite missing any one of them is not proof:
 *
 *   1. ROLE IDENTITY (first test). `sessions` needs no RLS — but the server still runs as
 *      `420ai_app`, and 0018 ships no explicit GRANT. A missing grant is a real, shippable bug that
 *      ONLY a non-owner handle can see.
 *   2. THE POSITIVE ASSERTION, before every negative one. A revocation check that rejects
 *      EVERYTHING — a typo'd column, a `sid` never persisted — is indistinguishable from correct
 *      revocation if the file only ever asserts 401s.
 *   3. THE DISCRIMINATOR: rejected WHILE STILL CRYPTOGRAPHICALLY VALID. See its test below.
 *   4. ISOLATION: revoking A must not touch B.
 *
 * MUTATION CHECK — the MEASURED result over the CURRENT 23 tests, so re-running it has a correct
 * expectation to compare against. (A stale count here is worse than none: an earlier version of
 * this comment still quoted "11 / 9" from a 20-test draft, which is the sort of number a reader
 * checks against and then distrusts the whole block.) Removing the `findLiveSession` lookup from
 * `resolvePrincipal` produces **12 failures / 11 passes**.
 *
 * THE LOAD-BEARING GATE IS ASSERTION 2 — if a positive test fails too, the suite is over-coupled
 * and cannot tell "revocation works" from "auth works". It does not; all four positives pass.
 *
 * Three of the passes are worth knowing, because each would otherwise look like a hole:
 *   - ISOLATION (assertion 4) FAILS under this mutation, not passes, and that is correct: this
 *     file's version also asserts A's own session died, not merely that B's survived. A B-only
 *     assertion would pass even if revocation did nothing at all.
 *   - "removing a member signs them out" PASSES, because the 401 is carried by the missing
 *     MEMBERSHIP rather than by revocation — the accidental mechanism 15.6 replaces. Its own
 *     comment explains, and it is the reason that test cannot stand in for the discriminator.
 *   - "an OPEN SSE stream dies" PASSES, because the stream re-checks the session in
 *     `routes/monitor.ts`, not here. That path has its own mutation proof: remove the per-tick
 *     `findLiveSession` there and this test fails while the rest of the file stays green.
 */
interface SentMail {
  to: string;
  subject: string;
  text: string;
}

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.6 sessions + revocation (two-role, HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let userOwner: string;
  let userMember: string;

  const sent: SentMail[] = [];
  const fakeMailer: Mailer = {
    appBaseUrl: "http://test.local",
    async send(mail) {
      sent.push(mail);
    },
  };

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
    app = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      mailer: fakeMailer,
      reconcileThrottleMs: 0,
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

  /** `GET /v1/auth/me`'s status for a token — the one probe every assertion in this file uses. */
  async function meStatus(token: string): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    return res.statusCode;
  }

  async function listOwn(token: string): Promise<
    {
      id: string;
      createdAt: string;
      expiresAt: string;
      userAgent: string | null;
      current: boolean;
    }[]
  > {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: asUser(token),
    });
    expect(res.statusCode, `list sessions: ${res.body}`).toBe(200);
    return (res.json() as { sessions: never[] }).sessions;
  }

  /** Pull the reset token out of the last mailed message's link. */
  function resetToken(mail: SentMail): string {
    const m = /\/reset\/([A-Za-z0-9_-]+)/.exec(mail.text);
    expect(m, `no reset link in mail body:\n${mail.text}`).not.toBeNull();
    return m![1]!;
  }

  /**
   * Hand-sign a token with a genuinely valid MAC over an ARBITRARY claim set — the one place in
   * this file that knows the byte format, so a forged token and a legacy token cannot drift apart.
   * `sid` omitted entirely reproduces a pre-0018 token.
   */
  function signClaims(claims: Record<string, unknown>): string {
    const iat = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ iat, exp: iat + 3600, ...claims })).toString(
      "base64url",
    );
    return `${body}.${createHmac("sha256", SESSION_SECRET).update(body).digest("base64url")}`;
  }

  beforeEach(async () => {
    sent.length = 0;
    // `sessions` is deliberately absent from this list: it references `users`, so CASCADE clears it
    // without being named — which is why no existing fixture in the repo needed editing for 15.6.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // M15 15.9 — mint the machine-tier bearer AFTER the truncate + identity seed, because
    // `api_keys` cascades away with `users`.
    SERVICE_TOKEN = await seedBootstrapKey(owner.db, ADMIN_EMAIL);
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    userMember = await setUserPassword(owner.db, "member@example.com", hashPassword(PASSWORD));

    // GOTCHA-1 as a seeding rule (CLAUDE.md 15.4): `setUserPassword` calls `ensurePersonalOrg`, so
    // each user already holds an `owner` membership in their own org. The colleague is therefore
    // MOVED into org A rather than given a SECOND membership — `findPrincipalByEmail` resolves the
    // FIRST membership by (created_at, id), so an inserted row would be shadowed and every
    // assertion about "a member" would silently be testing an owner.
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "member" })
      .where(eq(memberships.userId, userMember));
  });

  // ── 1. ROLE IDENTITY ──────────────────────────────────────────────────────────────────────
  //
  // First in the file, exactly as in `rls.int.test.ts`. Point APP_URL at the owner URL by mistake
  // and every test below still passes while proving nothing about the role the server runs as.
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

  // ── 2. THE POSITIVE ASSERTIONS ────────────────────────────────────────────────────────────

  it("a freshly minted session AUTHENTICATES, and login persisted a row for it", async () => {
    const token = await login("member@example.com");
    expect(await meStatus(token), "a fresh session must authenticate").toBe(200);

    // …and it is genuinely STATEFUL, not merely a working HMAC: the row exists, is unrevoked, and
    // its id is the token's `sid`. Without this, "revocation works" could be true of a token the
    // server never recorded, and every revoke below would be revoking nothing.
    const rows = await owner.db.execute<{ id: string; user_id: string; revoked_at: string | null }>(
      sql`select id, user_id, revoked_at from sessions where user_id = ${userMember}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.revoked_at).toBeNull();
    expect(verifySession(token, SESSION_SECRET)!.sid).toBe(rows.rows[0]!.id);
  });

  it("the session row records the request's user-agent, truncated to 256 chars (D-15.6-9)", async () => {
    const long = "M".repeat(400);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json", "user-agent": long },
      payload: { email: "member@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const rows = await owner.db.execute<{ user_agent: string }>(
      sql`select user_agent from sessions where user_id = ${userMember}`,
    );
    expect(rows.rows[0]!.user_agent).toHaveLength(256);
  });

  it("invite-accept and signup mint working sessions too, not just login", async () => {
    // Invite-accept: the id must escape its transaction to be minted against.
    const ownerToken = await login("owner@example.com");
    const invite = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(ownerToken),
      payload: { email: "new@example.com", role: "member" },
    });
    expect(invite.statusCode, invite.body).toBe(200);
    const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)!;
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/invites/accept",
      headers: { "content-type": "application/json" },
      payload: { token: link[1]!, password: PASSWORD },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const acceptedToken = (accepted.json() as { token: string }).token;
    expect(
      verifySession(acceptedToken, SESSION_SECRET)!.sid,
      "accept must carry a sid",
    ).toBeTruthy();
    expect(await meStatus(acceptedToken), "an accepted invite's session must work").toBe(200);

    // Signup: same shape, on an app with self-signup enabled.
    const signupApp = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      selfSignupEnabled: true,
      reconcileThrottleMs: 0,
      logger: false,
    });
    await signupApp.ready();
    try {
      const res = await signupApp.inject({
        method: "POST",
        url: "/v1/auth/signup",
        headers: { "content-type": "application/json" },
        payload: { email: "solo@example.com", password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      const token = (res.json() as { token: string }).token;
      expect(verifySession(token, SESSION_SECRET)!.sid, "signup must carry a sid").toBeTruthy();
      expect(await meStatus(token)).toBe(200);
    } finally {
      await signupApp.close();
    }
  });

  // ── 3. THE DISCRIMINATOR ──────────────────────────────────────────────────────────────────

  it("a REVOKED session is rejected even though its HMAC is still valid", async () => {
    const token = await login("member@example.com");

    // (2) POSITIVE FIRST — prove the credential works before we take it away.
    expect(await meStatus(token), "a fresh session must authenticate").toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: 1 });

    // (3) THE DISCRIMINATOR. `verifySession` is the pure crypto check with no database in it, so a
    // non-null result here proves the MAC still verifies and `exp` is still in the future. The 401
    // below therefore CANNOT be explained by expiry, a tampered token, a wrong secret, or a
    // malformed payload — the only remaining explanation is server-side revocation.
    //
    // Without this line the test passes just as well when the token was never valid at all, which
    // is precisely how a revocation test becomes theatre.
    const stillValid = verifySession(token, SESSION_SECRET);
    expect(stillValid, "token must still be crypto-valid").not.toBeNull();
    expect(stillValid!.exp, "and unexpired").toBeGreaterThan(Math.floor(Date.now() / 1000));

    expect(await meStatus(token), "a revoked session must be rejected").toBe(401);
  });

  it("revocation reaches other request/response routes, not just /v1/auth/me", async () => {
    // `resolvePrincipal` gates every request/response route, so this is a spot-check of that claim
    // rather than an exhaustive sweep — a revocation enforced on one route only is the exact bug
    // the single-chokepoint design exists to make impossible.
    //
    // NOTE WHAT THIS CANNOT SEE, because an earlier version of this test was titled "EVERY
    // authenticated route" and that was FALSE. It is built on `app.inject`, which cannot observe a
    // HIJACKED socket — so it was structurally incapable of noticing that `GET /v1/monitor/stream`
    // kept serving data forever after revocation. That gap is covered by its own test below, on a
    // real `listen()`. A sweep that cannot reach the route it needs to check is `bypassed ≠
    // enforced` one layer out.
    const token = await login("owner@example.com");
    expect(
      (await app.inject({ method: "GET", url: "/v1/members", headers: asUser(token) })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/projects", headers: asUser(token) })).statusCode,
    ).toBe(200);

    await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(token),
    });

    expect(
      (await app.inject({ method: "GET", url: "/v1/members", headers: asUser(token) })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/projects", headers: asUser(token) })).statusCode,
    ).toBe(401);
  });

  // ── 4. ISOLATION ──────────────────────────────────────────────────────────────────────────

  it("revoking user A's sessions leaves user B's live (behavioural, on the app role)", async () => {
    const a = await login("owner@example.com");
    const b = await login("member@example.com");
    expect(await meStatus(a)).toBe(200);
    expect(await meStatus(b)).toBe(200);

    await app.inject({ method: "POST", url: "/v1/auth/sessions/revoke-all", headers: asUser(a) });

    expect(await meStatus(a), "A's own session must be gone").toBe(401);
    // A `revokeAllSessions` that forgot its `WHERE user_id = $1` would pass every other test in
    // this file. This is the `min(org_id)` lesson one table over.
    expect(await meStatus(b), "B's session must be untouched").toBe(200);
  });

  // ── The remaining revocation triggers ─────────────────────────────────────────────────────

  it("logout kills ONLY the current session, leaving the same user's other devices signed in", async () => {
    const laptop = await login("member@example.com");
    const phone = await login("member@example.com");
    expect(await meStatus(laptop)).toBe(200);
    expect(await meStatus(phone)).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: asUser(laptop),
    });
    expect(res.statusCode).toBe(204);

    expect(await meStatus(laptop), "the logged-out device must be rejected").toBe(401);
    expect(await meStatus(phone), "the other device must stay signed in").toBe(200);
  });

  it("revoke-one signs out the named session and 404s for another user's id", async () => {
    const mine = await login("member@example.com");
    const other = await login("owner@example.com");
    const otherSid = verifySession(other, SESSION_SECRET)!.sid!;

    // 404, not 403: `revokeSession` collapses "unknown" and "not yours" so the route cannot become
    // an enumeration oracle (the same reasoning as the always-202 reset route, D-15.5-7).
    const cross = await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${otherSid}`,
      headers: asUser(mine),
    });
    expect(cross.statusCode).toBe(404);
    expect(await meStatus(other), "the other user's session must survive").toBe(200);

    const own = await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${verifySession(mine, SESSION_SECRET)!.sid}`,
      headers: asUser(mine),
    });
    expect(own.statusCode).toBe(204);
    expect(await meStatus(mine)).toBe(401);
  });

  it("revoke-one 400s on a malformed id (never a Postgres uuid-cast 500)", async () => {
    const token = await login("member@example.com");
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/auth/sessions/not-a-uuid",
      headers: asUser(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("a password CHANGE keeps the caller's session and kills their others (D-15.6-6)", async () => {
    const here = await login("member@example.com");
    const elsewhere = await login("member@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: json(here),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(204);

    expect(await meStatus(here), "the tab you changed it in must stay signed in").toBe(200);
    expect(await meStatus(elsewhere), "every other device must be signed out").toBe(401);
  });

  it("a password RESET kills EVERY session, sparing none (D-15.6-6, OWASP)", async () => {
    // The canonical takeover-recovery story: the attacker holds a session, the victim resets.
    const attacker = await login("member@example.com");
    const victimOther = await login("member@example.com");
    expect(await meStatus(attacker)).toBe(200);

    const request = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "member@example.com" },
    });
    expect(request.statusCode).toBe(202);
    const confirm = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token: resetToken(sent.at(-1)!), password: NEW_PASSWORD },
    });
    expect(confirm.statusCode, confirm.body).toBe(204);

    expect(await meStatus(attacker), "the attacker's session must die").toBe(401);
    expect(await meStatus(victimOther), "and so must every other one").toBe(401);
    // The reset actually took effect — otherwise this test would pass on a route that did nothing
    // but revoke, which is the same over-coupling trap the positive assertions guard against.
    await login("member@example.com", NEW_PASSWORD);
  });

  it("removing a member signs them out; a ROLE CHANGE deliberately does not (D-15.6-7)", async () => {
    const admin = await login("owner@example.com");
    const colleague = await login("member@example.com");
    expect(await meStatus(colleague)).toBe(200);

    // A demotion is re-resolved from `memberships` on the very next request, so revoking would sign
    // a colleague out for a change that had already taken effect.
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userMember}`,
      headers: json(admin),
      payload: { role: "viewer" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await meStatus(colleague), "a role change must NOT sign anyone out").toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userMember}`,
      headers: asUser(admin),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await meStatus(colleague), "a removed member must be signed out").toBe(401);

    // …and the session row is genuinely stamped, not merely unresolvable because the membership
    // vanished. That accidental mechanism is exactly what 15.6 replaces with a designed one: it
    // evaporates the moment M16 ships multi-org users.
    //
    // MEASURED, NOT ASSUMED: this test PASSED under the mutation check (revocation lookup removed
    // from `resolvePrincipal`) — the 401 above came entirely from the missing membership, and the
    // count below stayed 0 because the mutation broke ENFORCEMENT, not the revoke itself. So read
    // this test for what it actually proves: the row IS stamped (which is the part that will still
    // matter after M16), NOT that enforcement works. The discriminator test above is the only
    // thing proving the latter — do not let this one stand in for it.
    const live = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sessions where user_id = ${userMember} and revoked_at is null`,
    );
    expect(
      live.rows[0]!.n,
      "the removed member's sessions must be revoked, not just orphaned",
    ).toBe(0);
  });

  // ── Edge cases the plan names explicitly ──────────────────────────────────────────────────

  it("a PRE-0018 (sid-less) token is rejected, not grandfathered (D-15.6-5)", async () => {
    const legacy = signClaims({ sub: "member@example.com" });
    // It is crypto-valid — this is the same split the discriminator relies on.
    expect(verifySession(legacy, SESSION_SECRET), "the legacy MAC must verify").not.toBeNull();
    expect(verifySession(legacy, SESSION_SECRET)!.sid).toBeUndefined();
    expect(await meStatus(legacy), "a sid-less token must 401").toBe(401);
  });

  it("a well-formed but UNKNOWN sid is 401, and a NON-uuid sid is 401 (never a 500)", async () => {
    const sign = (sid: string) => signClaims({ sub: "member@example.com", sid });
    expect(await meStatus(sign("11111111-2222-3333-4444-555555555555"))).toBe(401);
    // The decision the plan left to the executor: `isUuid` GUARDS the lookup in `resolvePrincipal`
    // rather than the query being wrapped in a try/catch. Without it Postgres raises `22P02` on the
    // uuid cast and this is a 500 — breaking the repo-wide "malformed id → 401/404, never a
    // DB-cast 500" invariant. Pinned here so the guard cannot be removed silently.
    expect(await meStatus(sign("obviously-not-a-uuid")), "a non-uuid sid must not 500").toBe(401);
  });

  it("a token whose row EXPIRED is 401 even though the token's own exp is in the future", async () => {
    // The other direction from `verifySession`'s expiry check: both must be covered, because they
    // are two independent clocks and only one of them is inside the MAC.
    const token = await login("member@example.com");
    expect(await meStatus(token)).toBe(200);
    await owner.db.execute(
      sql`update sessions set expires_at = now() - interval '1 minute' where user_id = ${userMember}`,
    );
    expect(
      verifySession(token, SESSION_SECRET),
      "the token itself is still unexpired",
    ).not.toBeNull();
    expect(await meStatus(token)).toBe(401);
  });

  /**
   * A repeat revoke-all only ever COUNTS SESSIONS THAT WERE LIVE — it never re-stamps an
   * already-revoked row.
   *
   * `{revoked: 0}` is deliberately NOT asserted here, because over HTTP it is UNREACHABLE: calling
   * the route at all requires a live credential, so the caller's own session is always live and the
   * floor is 1. The zero case is real and is pinned one layer down, at
   * `packages/db/src/repositories/sessions.int.test.ts` ("revokeAllSessions is idempotent"). This
   * test's title used to claim the zero, which would have left a reader believing HTTP-level
   * idempotency-to-zero was covered when it cannot be.
   */
  it("a repeat revoke-all counts only the sessions that were LIVE, reached through the route", async () => {
    const a = await login("member@example.com");
    const b = await login("member@example.com");
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(a),
    });
    expect(first.json(), "both were live").toEqual({ revoked: 2 });
    expect(await meStatus(b), "and both are now dead").toBe(401);

    // A fresh credential is required to call the route again — which is exactly why the count can
    // never reach 0 here. The two already-revoked rows must not be counted a second time.
    const c = await login("member@example.com");
    const again = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(c),
    });
    expect(again.json(), "the two already-revoked rows must not be re-counted").toEqual({
      revoked: 1,
    });
  });

  // ── The session LIST ──────────────────────────────────────────────────────────────────────

  it("GET /v1/auth/sessions lists the caller's live sessions and flags the current one", async () => {
    const first = await login("member@example.com");
    const second = await login("member@example.com");
    await login("owner@example.com"); // another user's session must not appear

    const rows = await listOwn(second);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.find((r) => r.current)!.id).toBe(verifySession(second, SESSION_SECRET)!.sid);
    // ISO strings on the wire, produced by `.toISOString()` at the route — never a concatenated Date.
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0]!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // Exactly the documented wire shape — no column leaks through (CLAUDE.md 15.1).
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "createdAt",
      "current",
      "expiresAt",
      "id",
      "userAgent",
    ]);

    await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${verifySession(first, SESSION_SECRET)!.sid}`,
      headers: asUser(second),
    });
    expect(await listOwn(second), "a revoked session drops off the list").toHaveLength(1);
  });

  /**
   * THE SSE HOLE — the one route revocation did not reach, found in security review and PROVEN
   * against a live server before the fix.
   *
   * `GET /v1/monitor/stream` calls `reply.hijack()` and then serves the org's live snapshot on a
   * timer for as long as the client holds the socket. `resolvePrincipal` gated it ONCE, at connect.
   * So after `revoke-all` had made every other route 401, the open stream kept delivering frames —
   * indefinitely, and kept performing the org's reconcile WRITES and firing outbound alert delivery
   * on behalf of someone who was no longer a member. "Remove an employee, sign them out" is the
   * canonical use case for this slice, and the one long-lived thing they had open was what it
   * missed. The slice's own comments claimed there was no such gap; that claim was the real defect.
   *
   * THIS TEST NEEDS A REAL `listen()`. `app.inject` cannot observe a hijacked socket, which is
   * exactly why the "revocation reaches EVERY authenticated route" sweep above — built on
   * `inject` — could never have caught this. A structural sweep that cannot reach the route it
   * needs to check is the `bypassed ≠ enforced` shape one layer out.
   */
  it("an OPEN SSE stream dies when its session is revoked mid-flight", async () => {
    const streamApp = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      monitorStreamIntervalMs: 50,
      reconcileThrottleMs: 0,
      logger: false,
    });
    await streamApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (streamApp.server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      const token = await login("owner@example.com");
      const res = await fetch(`http://127.0.0.1:${port}/v1/monitor/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(res.status, "the stream must open for a live session").toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      /** Read frames until `match` appears, or reject once `budget` reads produce nothing. */
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

      // POSITIVE FIRST: the stream really is delivering data before we take the session away.
      expect(await readUntil(/^data: /m), "the stream must deliver a snapshot first").toMatch(
        /^data: /m,
      );

      const revoked = await app.inject({
        method: "POST",
        url: "/v1/auth/sessions/revoke-all",
        headers: asUser(token),
      });
      expect(revoked.statusCode).toBe(200);

      // THE ASSERTION. Before the fix this read produced more `data:` frames forever; now the tick
      // re-checks the session, writes one error frame and ends the socket.
      const after = await readUntil(/event: error/);
      expect(after, "a revoked stream must be terminated, not kept alive").toContain(
        "event: error",
      );
      expect(after).toContain("session revoked");
    } finally {
      controller.abort();
      await streamApp.close();
    }
  });

  // ── The GATES on the four new routes ──────────────────────────────────────────────────────

  it("all four new routes 401 with no Authorization header at all", async () => {
    const unauth = [
      { method: "GET" as const, url: "/v1/auth/sessions" },
      { method: "DELETE" as const, url: "/v1/auth/sessions/11111111-2222-3333-4444-555555555555" },
      { method: "POST" as const, url: "/v1/auth/logout" },
      { method: "POST" as const, url: "/v1/auth/sessions/revoke-all" },
    ];
    for (const req of unauth) {
      const res = await app.inject(req);
      expect(res.statusCode, `${req.method} ${req.url} with no bearer`).toBe(401);
      // The 401 body is asserted across the existing int suites and rendered by the dashboard —
      // 15.6 adds routes, it never changes what a rejection looks like.
      expect(res.json()).toEqual({ error: "admin authorization required" });
    }
  });

  /**
   * THE `viewer` GATE, exercised rather than merely stated. `routes/auth.ts` justifies gating these
   * four routes at `viewer` with "a read-only account must still be able to sign out a stolen
   * laptop" — and until this test that promise lived only in a comment. `authorized(principal, …)`
   * is hand-written at each of the four call sites, so a single typo to `"admin"` would break the
   * stated design intent with every other test in the repo still green (`rbac.int.test.ts` does not
   * enumerate `/v1/auth/sessions*` either).
   *
   * Seeded as a THIRD user moved into org A at `viewer`, rather than by demoting the member
   * mid-test: `setUserPassword` auto-creates a personal `owner` membership, so the membership is
   * MOVED, not added (the CLAUDE.md 15.4 seeding rule).
   */
  it("a VIEWER can list, log out of, and revoke their own sessions", async () => {
    const viewerId = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, viewerId));

    const token = await login("viewer@example.com");
    // Positive first: prove the account is really a viewer, so a 200 below is not just "everyone
    // is an owner in this fixture" — the trap CLAUDE.md's 15.4 lesson names explicitly.
    const denied = await app.inject({ method: "GET", url: "/v1/invites", headers: asUser(token) });
    expect(denied.statusCode, "the fixture must really be a viewer").toBe(403);

    expect(await meStatus(token)).toBe(200);
    expect(await listOwn(token)).toHaveLength(1);

    const revokeAll = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(token),
    });
    expect(revokeAll.statusCode, "a viewer must be able to sign out everywhere").toBe(200);
    expect(await meStatus(token)).toBe(401);

    const second = await login("viewer@example.com");
    const loggedOut = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: asUser(second),
    });
    expect(loggedOut.statusCode, "a viewer must be able to log out").toBe(204);
    expect(await meStatus(second)).toBe(401);
  });

  // ── The MACHINE tier (an API key as of 15.9, D-M15-7) — it must not regress ───────────────

  it("an API-KEY caller works everywhere and its logout is a no-op 204", async () => {
    expect(
      await meStatus(SERVICE_TOKEN),
      "an API key has no session and must not need one (D-15.9-5)",
    ).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: asUser(SERVICE_TOKEN),
    });
    expect(logout.statusCode, "logout is idempotent — nothing to revoke is still success").toBe(
      204,
    );
    expect(await meStatus(SERVICE_TOKEN), "and it must still authenticate afterwards").toBe(200);

    // Its session list is empty (nothing is flagged `current`), rather than erroring.
    expect(await listOwn(SERVICE_TOKEN)).toEqual([]);
  });

  it("revoke-all by a session user does NOT affect the API-KEY tier", async () => {
    const token = await login("member@example.com");
    await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(token),
    });
    expect(await meStatus(SERVICE_TOKEN)).toBe(200);
  });
});
