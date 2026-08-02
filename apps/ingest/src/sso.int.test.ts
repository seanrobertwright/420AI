import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, createInvite, ensurePersonalOrg, setUserPassword, users } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { SsoProviderError, type SsoProfile, type SsoProvider } from "./sso/provider.js";
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

const stubAnalysis: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in sso tests", "unavailable");
  },
};

/**
 * A deterministic stand-in for Google/GitHub. `profile` is reassigned per test, which is what lets
 * THE DISCRIMINATOR run the SAME callback twice and change only the database.
 *
 * `fail` makes the next exchange throw, so the 502 mapping is provable without a socket.
 */
interface StubSso extends SsoProvider {
  profile: SsoProfile;
  fail: boolean;
  /** The `redirect_uri` the ROUTE handed the provider — the D-15.7-6 evidence. */
  lastRedirectUri: string | null;
}
function stubSso(usesPkce: boolean): StubSso {
  return {
    usesPkce,
    profile: { subject: "unset", email: null, emailVerified: false },
    fail: false,
    lastRedirectUri: null,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      return `https://stub.test/auth?state=${state}&r=${encodeURIComponent(redirectUri)}${
        codeChallenge ? `&c=${codeChallenge}` : ""
      }`;
    },
    async exchange({ redirectUri }) {
      this.lastRedirectUri = redirectUri;
      if (this.fail) throw new SsoProviderError("stub provider is down");
      return this.profile;
    },
  };
}

/**
 * M15 15.7 — THE SLICE'S PROOF. A TWO-ROLE HTTP suite whose centre is one discriminating fact:
 *
 *   THE SAME PROVIDER RESPONSE IS ADMITTED IN ONE WORLD AND REFUSED IN THE OTHER, AND THE ONLY
 *   DIFFERENCE BETWEEN THE TWO WORLDS IS WHETHER A `users` ROW ALREADY EXISTED.
 *
 * That shape is chosen deliberately over 15.6's ("valid yet rejected"), because an over-permissive
 * SSO login does not LOOK like a failure: it returns 200, mints a real session, and every existing
 * test stays green — they all log in as somebody who is legitimately themselves. Nothing anywhere
 * reports that an identity was ADOPTED rather than authenticated.
 *
 * TWO POSTGRES ROLES, per `bypassed ≠ enforced`: `owner` seeds (TRUNCATE needs ownership), and the
 * app under test is built on the NON-OWNER `appRole` — which is also the only handle that can see
 * a missing GRANT on `sso_identities`.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.7 SSO (two-role, HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  /** Signup ENABLED — the app most tests drive. */
  let app: FastifyInstance;
  /** Signup options entirely OMITTED — the default-off assertion. */
  let appDefault: FastifyInstance;
  let google: StubSso;
  let github: StubSso;
  let orgA: string;
  let userOwner: string;

  beforeAll(async () => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
    google = stubSso(true);
    github = stubSso(false);
    app = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubAnalysis,
      ssoProviders: { google, github },
      ssoSignupEnabled: true,
      appBaseUrl: "https://app.test",
      logger: false,
    });
    appDefault = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubAnalysis,
      ssoProviders: { google },
      // ssoSignupEnabled DELIBERATELY OMITTED — see the default-off test.
      logger: false,
      metrics: false,
    });
    await app.ready();
    await appDefault.ready();
  });

  afterAll(async () => {
    // Both apps AND both pools, or vitest hangs on an open handle.
    await app.close();
    await appDefault.close();
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    google.profile = { subject: "unset", email: null, emailVerified: false };
    github.profile = { subject: "unset", email: null, emailVerified: false };
    google.fail = false;
    github.fail = false;
    google.lastRedirectUri = null;
    github.lastRedirectUri = null;
    // `sso_identities` is NOT named here and does not need to be: it carries an FK to `users`, so
    // `TRUNCATE … users … CASCADE` clears it (verified live — psql emits a NOTICE naming it). This
    // is why the slice adds the table to no TRUNCATE fixture anywhere in the repo.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    // M15 15.9 — mint the machine-tier bearer AFTER the truncate + identity seed, because
    // `api_keys` cascades away with `users`.
    SERVICE_TOKEN = await seedBootstrapKey(owner.db, ADMIN_EMAIL);
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
  });

  // ── helpers ───────────────────────────────────────────────────────────────────────────────

  function ssoCallback(
    provider: string,
    body: Record<string, unknown> = {},
    instance: FastifyInstance = app,
  ) {
    return instance.inject({
      method: "POST",
      url: `/v1/auth/sso/${provider}/callback`,
      headers: { "content-type": "application/json" },
      payload: { code: "stub-code", ...body },
    });
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...asUser(token), "content-type": "application/json" });

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, `login for ${email}: ${res.body}`).toBe(200);
    return (res.json() as { token: string }).token;
  }

  async function identityCount(subject: string): Promise<number> {
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sso_identities where subject = ${subject}`,
    );
    return r.rows[0]!.n;
  }

  async function membershipCount(email: string): Promise<number> {
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from memberships m join users u on u.id = m.user_id
          where u.email = ${email}`,
    );
    return r.rows[0]!.n;
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
  });

  // 2 ── THE POSITIVE ASSERTION (the `delivered.length > 0` lesson). A resolver that refuses
  // EVERYTHING — a typo'd column, a missing grant, a stub wired wrong — is indistinguishable from
  // correct anti-takeover policy if the suite only ever asserts failures.
  it("admits a BRAND-NEW verified identity and the minted session authenticates", async () => {
    google.profile = { subject: "g-new", email: "newcomer@example.com", emailVerified: true };
    const res = await ssoCallback("google");
    expect(res.statusCode, res.body).toBe(200);
    const { token } = res.json() as { token: string };
    expect(token).toBeTruthy();

    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe("newcomer@example.com");
  });

  // 3 ── THE DISCRIMINATOR: same provider response, opposite outcome, ONE row of difference.
  it("a VERIFIED provider identity does NOT adopt a pre-existing account", async () => {
    // POSITIVE FIRST, IN THE SAME SHAPE — prove this exact callback succeeds when the address is
    // genuinely new, so the 409 below cannot be blamed on the stub, the wiring or the flag.
    google.profile = { subject: "g-newcomer", email: "newcomer@example.com", emailVerified: true };
    const ok = await ssoCallback("google");
    expect(ok.statusCode, "a brand-new verified identity must be admitted").toBe(200);

    // THE ONLY DIFFERENCE: `victim@example.com` already has a `users` row. Note it is a PRE-SEEDED
    // one (password_hash NULL) — the exact artefact D-M15-8 was written about, and the row an
    // auto-adopting implementation hands over. Its email is IDENTICAL to what the provider
    // asserts, and the provider says `emailVerified: true`, so nothing about the provider's answer
    // explains the refusal. The `users` row is the only variable.
    await owner.db.insert(users).values({ email: "victim@example.com" });
    google.profile = { subject: "g-attacker", email: "victim@example.com", emailVerified: true };
    const res = await ssoCallback("google");

    expect(res.statusCode, "a pre-existing account must never be adopted").toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("link_required");

    // …and the refusal must be TOTAL, not merely a non-200. A handler that 409s after having
    // already written the link, or after minting a session, has still performed the takeover.
    expect(
      (res.json() as { token?: string }).token,
      "no session may be issued on a refused link",
    ).toBeUndefined();
    expect(
      await identityCount("g-attacker"),
      "no identity row may be written on a refused link",
    ).toBe(0);
  });

  it("refuses a pre-existing account even when it HAS a password (the ordinary case)", async () => {
    google.profile = { subject: "g-owner", email: "owner@example.com", emailVerified: true };
    const res = await ssoCallback("google");
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("link_required");
  });

  // 4 ── ISOLATION. `(provider, subject)` is the key, so two providers may share a subject string.
  // A resolver that looked up by `subject` alone would pass every other test in this file.
  it("does not confuse two providers that share a subject string", async () => {
    google.profile = { subject: "12345", email: "gu@example.com", emailVerified: true };
    expect((await ssoCallback("google")).statusCode).toBe(200);

    // The SAME subject, on GitHub, for a DIFFERENT address. If the resolver keyed on subject alone
    // it would silently log this person in as the Google user above.
    github.profile = { subject: "12345", email: "ghu@example.com", emailVerified: true };
    const res = await ssoCallback("github");
    expect(res.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser((res.json() as { token: string }).token),
    });
    expect((me.json() as { email: string }).email).toBe("ghu@example.com");
  });

  // 5 ── UNLINK LOCKOUT, both directions.
  it("refuses to unlink the only credential of an SSO-created account, and allows it otherwise", async () => {
    google.profile = { subject: "g-solo", email: "solo@example.com", emailVerified: true };
    const created = await ssoCallback("google");
    expect(created.statusCode).toBe(200);
    const token = (created.json() as { token: string }).token;

    const refused = await app.inject({
      method: "DELETE",
      url: "/v1/auth/sso/google",
      headers: asUser(token),
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { reason: string }).reason).toBe("last_credential");

    // THE POSITIVE COMPLEMENT — without it this is another "rejects-everything" test. Give the
    // same account a SECOND provider and the unlink succeeds.
    github.profile = { subject: "gh-solo", email: "solo@example.com", emailVerified: true };
    const linked = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/github/link",
      headers: json(token),
      payload: { code: "stub-code" },
    });
    expect(linked.statusCode, linked.body).toBe(204);
    const allowed = await app.inject({
      method: "DELETE",
      url: "/v1/auth/sso/google",
      headers: asUser(token),
    });
    expect(allowed.statusCode).toBe(204);
  });

  // ── branch 1: the link is keyed on the subject, never the email ────────────────────────────

  it("logs a linked identity in even after its provider-side email CHANGES", async () => {
    google.profile = { subject: "g-stable", email: "before@example.com", emailVerified: true };
    expect((await ssoCallback("google")).statusCode).toBe(200);

    // Same subject, different asserted address. Branch 1 does not consult the email at all, so
    // this must resolve to the SAME account — and must NOT be treated as a new signup.
    google.profile = { subject: "g-stable", email: "after@example.com", emailVerified: true };
    const res = await ssoCallback("google");
    expect(res.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser((res.json() as { token: string }).token),
    });
    // The account's OWN address, not the provider's newly-asserted one.
    expect((me.json() as { email: string }).email).toBe("before@example.com");
  });

  it("an unverified email is refused EVEN when the address is brand new", async () => {
    google.profile = { subject: "g-unver", email: "fresh@example.com", emailVerified: false };
    const res = await ssoCallback("google");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { reason: string }).reason).toBe("email_unverified");
    expect(await identityCount("g-unver")).toBe(0);
  });

  it("a provider asserting NO email is refused on the login path", async () => {
    github.profile = { subject: "gh-noemail", email: null, emailVerified: false };
    const res = await ssoCallback("github");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { reason: string }).reason).toBe("email_unverified");
  });

  // ── branch 3: invite acceptance through SSO ────────────────────────────────────────────────

  it("accepts an invitation and creates EXACTLY ONE membership in the inviting org", async () => {
    const { token: inviteToken } = await createInvite(owner.db, orgA, {
      email: "invitee@example.com",
      role: "member",
      invitedByUserId: userOwner,
    });
    google.profile = { subject: "g-invitee", email: "invitee@example.com", emailVerified: true };
    const res = await ssoCallback("google", { inviteToken });
    expect(res.statusCode, res.body).toBe(200);

    // THE D-15.5-9 TRAP: a personal `owner` membership created first would shadow the invited one
    // forever, because `findPrincipalByEmail` resolves the FIRST membership by (created_at, id).
    // A count of 1 is what proves `createUserWithoutPassword` skipped `ensurePersonalOrg`.
    expect(await membershipCount("invitee@example.com")).toBe(1);
    const r = await owner.db.execute<{ org_id: string; role: string }>(
      sql`select m.org_id, m.role from memberships m join users u on u.id = m.user_id
          where u.email = 'invitee@example.com'`,
    );
    expect(r.rows[0]!.org_id).toBe(orgA);
    expect(r.rows[0]!.role).toBe("member");

    // M15 15.10 — THE SSO HALF OF `member.joined`, which is the only audit call site with a
    // distinct payload and had no assertion anywhere.
    //
    // Because the write is in-transaction, a THROWING audit call would already fail the assertions
    // above — but a WRONG one would not. Stamping the invitee's personal org instead of the
    // inviting org, or the wrong actor, writes a permanently incorrect row into the one table the
    // application cannot correct, and the break-glass reader has no way to notice.
    //
    // Read on the OWNER handle: the app role reads zero rows from `audit_events` by design, so an
    // assertion made through the server's own connection would pass vacuously.
    const audit = await owner.db.execute<{
      org_id: string;
      actor_user_id: string;
      target_user_id: string | null;
      actor_email: string;
      metadata: Record<string, unknown>;
    }>(
      sql`select org_id, actor_user_id, target_user_id, actor_email, metadata
          from audit_events where action = 'member.joined'`,
    );
    expect(audit.rows).toHaveLength(1);
    // The INVITING org, never the invitee's own.
    expect(audit.rows[0]!.org_id).toBe(orgA);
    expect(audit.rows[0]!.actor_email).toBe("invitee@example.com");
    // Actor === target: an invite is redeemed by its recipient.
    expect(audit.rows[0]!.actor_user_id).toBe(audit.rows[0]!.target_user_id);
    expect(audit.rows[0]!.metadata).toEqual({ role: "member", via: "sso" });
  });

  it("refuses an invitation whose email ALREADY has a users row", async () => {
    // Branch 4's rule applies INSIDE branch 3, and until this test nothing pinned it: mutating the
    // guard out left all 24 other tests green. It is the invite-flavoured half of the slice's
    // central claim — without it, a later refactor to `ensureUserByEmail` (an UPSERT that does not
    // throw) would silently ADOPT the pre-existing row for anyone holding a leaked invite link,
    // which is exactly D-15.7-4's takeover.
    await owner.db.insert(users).values({ email: "existing@example.com" });
    const { token: inviteToken } = await createInvite(owner.db, orgA, {
      email: "existing@example.com",
      role: "member",
      invitedByUserId: userOwner,
    });
    google.profile = { subject: "g-inv-dup", email: "existing@example.com", emailVerified: true };
    const res = await ssoCallback("google", { inviteToken });

    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("link_required");
    expect(await identityCount("g-inv-dup")).toBe(0);
  });

  it("refuses an invitation whose email differs from the verified provider email", async () => {
    const { token: inviteToken } = await createInvite(owner.db, orgA, {
      email: "intended@example.com",
      role: "member",
      invitedByUserId: userOwner,
    });
    google.profile = { subject: "g-wrong", email: "someone-else@example.com", emailVerified: true };
    const res = await ssoCallback("google", { inviteToken });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("invite_mismatch");

    // The invite is UNSPENT, so the right person can still use it — nothing was written.
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from invites where accepted_at is null`,
    );
    expect(r.rows[0]!.n).toBe(1);
    expect(await identityCount("g-wrong")).toBe(0);
  });

  // ── branches 5/6: the signup gate ──────────────────────────────────────────────────────────

  it("refuses to CREATE an account when ssoSignupEnabled is omitted (the default-off assertion)", async () => {
    google.profile = { subject: "g-default", email: "nobody@example.com", emailVerified: true };
    const res = await ssoCallback("google", {}, appDefault);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { reason: string }).reason).toBe("signup_disabled");
    expect(await identityCount("g-default")).toBe(0);
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from users where email = 'nobody@example.com'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  // ── the link route: branch 4's escape hatch ────────────────────────────────────────────────

  it("lets an authenticated user LINK a provider and then sign in with it", async () => {
    // The pre-existing account that SSO refused above.
    google.profile = { subject: "g-owner-link", email: "owner@example.com", emailVerified: true };
    expect((await ssoCallback("google")).statusCode).toBe(409);

    const session = await login("owner@example.com");
    const linked = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/link",
      headers: json(session),
      payload: { code: "stub-code" },
    });
    expect(linked.statusCode, linked.body).toBe(204);

    // The SAME callback that was refused a moment ago now succeeds — as the SAME user.
    const res = await ssoCallback("google");
    expect(res.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser((res.json() as { token: string }).token),
    });
    expect((me.json() as { email: string }).email).toBe("owner@example.com");
  });

  it("accepts an UNVERIFIED provider email on the authenticated link path", async () => {
    // Deliberately different from the login path: here the account is proven by an existing
    // session and the stored email is cosmetic, so verification buys nothing.
    const session = await login("owner@example.com");
    github.profile = { subject: "gh-unver", email: "whatever@example.com", emailVerified: false };
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/github/link",
      headers: json(session),
      payload: { code: "stub-code" },
    });
    expect(res.statusCode, res.body).toBe(204);
  });

  it("refuses to link an identity already bound to another user (409 identity_taken)", async () => {
    google.profile = { subject: "g-taken", email: "first@example.com", emailVerified: true };
    expect((await ssoCallback("google")).statusCode).toBe(200);

    const session = await login("owner@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/link",
      headers: json(session),
      payload: { code: "stub-code" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("identity_taken");
  });

  it("lists the caller's identities without ever exposing the provider subject", async () => {
    google.profile = { subject: "g-list", email: "lister@example.com", emailVerified: true };
    const token = (await ssoCallback("google")).json() as { token: string };
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/sso/identities",
      headers: asUser(token.token),
    });
    expect(res.statusCode).toBe(200);
    const { identities } = res.json() as { identities: Record<string, unknown>[] };
    expect(identities).toHaveLength(1);
    expect(identities[0]!.provider).toBe("google");
    expect(identities[0]).not.toHaveProperty("subject");
    expect(res.body).not.toContain("g-list");
  });

  it("answers an API-KEY caller with an empty list, not a 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/sso/identities",
      headers: asUser(SERVICE_TOKEN),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { identities: unknown[] }).identities).toEqual([]);
  });

  it("401s the three gated routes without a credential", async () => {
    for (const [method, url] of [
      ["GET", "/v1/auth/sso/identities"],
      ["DELETE", "/v1/auth/sso/google"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const link = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/link",
      headers: { "content-type": "application/json" },
      payload: { code: "x" },
    });
    expect(link.statusCode).toBe(401);
  });

  // ── the start endpoint + provider discovery ────────────────────────────────────────────────

  it("reports which providers are CONFIGURED", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/sso/providers" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { providers: string[] }).providers.sort()).toEqual(["github", "google"]);
    // The app built with only Google configured must not advertise GitHub.
    const one = await appDefault.inject({ method: "GET", url: "/v1/auth/sso/providers" });
    expect((one.json() as { providers: string[] }).providers).toEqual(["google"]);
  });

  it("starts a flow with a server-derived redirect_uri and a PKCE verifier for Google only", async () => {
    const g = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/start",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(g.statusCode).toBe(200);
    const gb = g.json() as { authorizeUrl: string; state: string; codeVerifier?: string };
    expect(gb.state).toBeTruthy();
    expect(gb.codeVerifier).toBeTruthy();
    // D-15.7-6: DERIVED from appBaseUrl, never supplied by the caller (the body schema has no
    // `redirectUri` property at all).
    expect(gb.authorizeUrl).toContain(
      encodeURIComponent("https://app.test/api/auth/sso/google/callback"),
    );

    const gh = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/github/start",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    // GitHub does not document PKCE, so no verifier is issued for it.
    expect((gh.json() as { codeVerifier?: string }).codeVerifier).toBeUndefined();
  });

  it("IGNORES a caller-supplied redirectUri and exchanges against the derived one (D-15.7-6)", async () => {
    // The body schema declares `additionalProperties: false`, and Fastify's ajv is configured with
    // `removeAdditional` — so a smuggled `redirectUri` is STRIPPED rather than 400'd. That is the
    // stronger outcome (the field cannot reach the handler at all), but it means the proof has to
    // be what the PROVIDER received, not what the schema rejected. An earlier version of this test
    // asserted a 400 and would have passed for the wrong reason the day the schema loosened.
    google.profile = { subject: "g-redir", email: "redir@example.com", emailVerified: true };
    const res = await ssoCallback("google", { redirectUri: "https://evil.test/steal" });
    expect(res.statusCode).toBe(200);
    expect(google.lastRedirectUri).toBe("https://app.test/api/auth/sso/google/callback");
    expect(google.lastRedirectUri).not.toContain("evil.test");
  });

  it("404s an unknown or unconfigured provider on every flow route", async () => {
    expect((await ssoCallback("gitlab")).statusCode).toBe(404);
    const start = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/gitlab/start",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(start.statusCode).toBe(404);
    // Configured-but-absent is also a 404, never a 500 from indexing an empty map.
    const absent = await ssoCallback("github", {}, appDefault);
    expect(absent.statusCode).toBe(404);
  });

  it("maps a provider outage to 502, never a leaked 500", async () => {
    google.fail = true;
    const res = await ssoCallback("google");
    expect(res.statusCode).toBe(502);
  });

  // ── composition with 15.6 ──────────────────────────────────────────────────────────────────

  it("mints an ordinary revocable session — revoke-all ends an SSO login", async () => {
    google.profile = { subject: "g-revoke", email: "revoked@example.com", emailVerified: true };
    const token = (await ssoCallback("google")).json() as { token: string };
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token.token) }))
        .statusCode,
    ).toBe(200);

    const revoke = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-all",
      headers: asUser(token.token),
    });
    expect(revoke.statusCode).toBe(200);
    // SSO adds no new enforcement point: the session is an ordinary 15.6 row, so 15.6's revocation
    // applies to it unchanged.
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token.token) }))
        .statusCode,
    ).toBe(401);
  });
});
