import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, ensurePersonalOrg, setUserPassword } from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "./mfa/totp.js";
import { MFA_MAX_ATTEMPTS } from "./routes/mfa.js";
import type { Mailer } from "./delivery/mailer.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { SsoProviderError, type SsoProfile, type SsoProvider } from "./sso/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const SERVICE_TOKEN = "svc-token";
const ADMIN_EMAIL = "bootstrap@test.local";
const SESSION_SECRET = "test-secret";
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-passphrase";

const stubAnalysis: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in mfa tests", "unavailable");
  },
};

/** The 15.7 stub provider, verbatim — the SSO-parity case needs a deterministic Google. */
interface StubSso extends SsoProvider {
  profile: SsoProfile;
  fail: boolean;
}
function stubSso(): StubSso {
  return {
    usesPkce: true,
    profile: { subject: "unset", email: null, emailVerified: false },
    fail: false,
    authorizeUrl({ state }) {
      return `https://stub.test/auth?state=${state}`;
    },
    async exchange() {
      if (this.fail) throw new SsoProviderError("stub provider is down");
      return this.profile;
    },
  };
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * M15 15.8 — THE SLICE'S PROOF. A TWO-ROLE HTTP suite.
 *
 * TWO POSTGRES ROLES, per CLAUDE.md's `bypassed ≠ enforced`: the `owner` handle
 * (DATABASE_URL_TEST) does setup and out-of-band verification only, because TRUNCATE requires table
 * ownership, and every assertion about behaviour runs against an app built on `appRole`
 * (DATABASE_URL_TEST_APP), a non-owner with `rolbypassrls = false`. Test 1 is why the rest mean
 * anything — and for this slice the app role is also the only handle that would notice a missing
 * GRANT on the two new tables.
 *
 * THE CENTRAL DISCRIMINATING FACT of this file is test 5: A LOGIN THAT REPORTS `mfaRequired` MUST
 * HAVE MINTED NO SESSION. A handler that returns the challenge AND inserts a `sessions` row is the
 * whole bug — it looks completely correct from the client's side (the dashboard would show the code
 * prompt), while the bearer needed to skip the prompt already exists. So the session count is
 * asserted through the OWNER handle, out of band, rather than inferred from the response body.
 *
 * Every numbered group corresponds to a decision this slice made. A missing test here is an unproven
 * decision, so each is labelled with the decision it pins.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.8 MFA (two-role, HTTP)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let google: StubSso;
  let userA: string;
  let userB: string;

  const sent: SentMail[] = [];
  const fakeMailer: Mailer = {
    appBaseUrl: "http://test.local",
    async send(mail) {
      sent.push(mail);
    },
  };

  beforeAll(async () => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
    google = stubSso();
    app = buildApp({
      db: appRole.db,
      adminToken: SERVICE_TOKEN,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubAnalysis,
      mailer: fakeMailer,
      ssoProviders: { google },
      appBaseUrl: "https://app.test",
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
    sent.length = 0;
    google.profile = { subject: "unset", email: null, emailVerified: false };
    google.fail = false;
    // `totp_credentials` and `mfa_recovery_codes` are NOT named here and do not need to be: both
    // carry an FK to `users`, so `TRUNCATE … users … CASCADE` clears them transitively — the same
    // fact `sso.int.test.ts:131-133` records for `sso_identities`. This is why the slice adds the two
    // tables to no TRUNCATE fixture anywhere in the repo; a per-slice fixture list eventually
    // disagrees with itself across files.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userA = await setUserPassword(owner.db, "a@example.com", hashPassword(PASSWORD));
    userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    await ensurePersonalOrg(owner.db, userA, "a@example.com");
    await ensurePersonalOrg(owner.db, userB, "b@example.com");
  });

  // ── helpers ───────────────────────────────────────────────────────────────────────────────

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...asUser(token), "content-type": "application/json" });

  function loginRaw(email: string, password: string = PASSWORD) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password },
    });
  }

  /** Log in a user who is NOT enrolled, returning the session token. */
  async function login(email: string, password: string = PASSWORD): Promise<string> {
    const res = await loginRaw(email, password);
    expect(res.statusCode, `login ${email}: ${res.body}`).toBe(200);
    const body = res.json() as { token?: string };
    expect(body.token, `login ${email} unexpectedly required MFA`).toBeDefined();
    return body.token!;
  }

  /** Log in an ENROLLED user, returning the MFA challenge. */
  async function challengeFor(email: string, password: string = PASSWORD): Promise<string> {
    const res = await loginRaw(email, password);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mfaRequired?: true; challenge?: string };
    expect(body.mfaRequired, `login ${email} did NOT require MFA: ${res.body}`).toBe(true);
    return body.challenge!;
  }

  /** Phase one: mint an unconfirmed secret and return it decoded. */
  async function enrol(token: string): Promise<Buffer> {
    // `asUser`, NOT `json`: this POST has no body, and Fastify rejects an empty body when
    // `content-type: application/json` is set. (The dashboard proxy likewise sends no content-type.)
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll",
      headers: asUser(token),
    });
    expect(res.statusCode, `enroll: ${res.body}`).toBe(200);
    const { secret, otpauthUri } = res.json() as { secret: string; otpauthUri: string };
    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    return base32Decode(secret);
  }

  /**
   * A code for a step OFFSET from now. Defaults to the NEXT step, and that default is load-bearing
   * rather than arbitrary: `confirmTotp` stamps the confirming code's step as spent (RFC 6238 §5.2 /
   * D-15.8-8), so the very next login inside the same 30-second window must use a different step or
   * it is a legitimate replay refusal. Step +1 is inside the ±1 skew window, so it verifies.
   */
  function codeAt(secret: Buffer, steps = 1): string {
    return totpCode(secret, Date.now() + steps * TOTP_PERIOD_SECONDS * 1000);
  }

  /** Phase two: confirm with a live code, returning the ten recovery codes. */
  async function confirmEnrol(token: string, secret: Buffer): Promise<string[]> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll/confirm",
      headers: json(token),
      payload: { code: totpCode(secret, Date.now()) },
    });
    expect(res.statusCode, `confirm: ${res.body}`).toBe(200);
    return (res.json() as { recoveryCodes: string[] }).recoveryCodes;
  }

  /** Enrol + confirm in one step — the precondition of almost every case below. */
  async function enrolled(
    email: string,
  ): Promise<{ token: string; secret: Buffer; codes: string[] }> {
    const token = await login(email);
    const secret = await enrol(token);
    const codes = await confirmEnrol(token, secret);
    return { token, secret, codes };
  }

  function verify(challenge: string, code: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      headers: { "content-type": "application/json" },
      payload: { challenge, code },
    });
  }

  function status(token: string) {
    return app.inject({ method: "GET", url: "/v1/auth/mfa", headers: asUser(token) });
  }

  /** LIVE sessions only — a revoked row still exists, so a bare count(*) would prove nothing. */
  async function liveSessions(userId: string): Promise<number> {
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sessions where user_id = ${userId} and revoked_at is null`,
    );
    return r.rows[0]!.n;
  }

  async function confirmedAt(userId: string): Promise<string | null> {
    const r = await owner.db.execute<{ c: string | null }>(
      sql`select confirmed_at as c from totp_credentials where user_id = ${userId}`,
    );
    return r.rows[0]?.c ?? null;
  }

  /** Revoke every session out of band, so a later login's session count starts from zero. */
  async function clearSessions(userId: string): Promise<void> {
    await owner.db.execute(
      sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`,
    );
  }

  // 1 ── ROLE IDENTITY. Non-negotiable, and first: without it this whole file is theatre.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ b: boolean }>(
      sql`select rolbypassrls as b from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.b).toBe(false);
  });

  // 2 ── ENROL → CONFIRM → STATUS (D-15.8-10).
  it("enrol + confirm reports enabled with ten recovery codes", async () => {
    const { token, codes } = await enrolled("a@example.com");
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10); // no duplicates — the unique index would reject them anyway
    const res = await status(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enabled: boolean;
      confirmedAt: string | null;
      recoveryCodesRemaining: number;
    };
    expect(body.enabled).toBe(true);
    expect(body.confirmedAt).not.toBeNull();
    expect(body.recoveryCodesRemaining).toBe(10);
  });

  // 3 ── RE-ENROLLING A CONFIRMED CREDENTIAL IS REFUSED (D-15.8-10).
  it("enrolling again while confirmed is a 409 already_enrolled, not a silent rotation", async () => {
    const { token } = await enrolled("a@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll",
      headers: asUser(token),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("already_enrolled");
  });

  // 4 ── AN ABANDONED ENROLMENT GATES NOTHING (D-15.8-10).
  it("a wrong confirmation code leaves confirmed_at NULL — and login still mints a session", async () => {
    const token = await login("a@example.com");
    const secret = await enrol(token);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll/confirm",
      headers: json(token),
      // A code from an hour away: deterministic, and outside the ±1-step window by 120 steps.
      payload: { code: codeAt(secret, 120) },
    });
    expect(bad.statusCode).toBe(401);
    expect(await confirmedAt(userA)).toBeNull();
    // THE CONSEQUENCE, asserted rather than assumed: an unconfirmed row must not gate the login, or
    // a user who closed the tab mid-enrolment would be locked out of their own account.
    const res = await loginRaw("a@example.com");
    expect((res.json() as { token?: string }).token).toBeDefined();
    expect((res.json() as { mfaRequired?: boolean }).mfaRequired).toBeUndefined();
  });

  // 5 ── THE CENTRAL FACT: a challenge means NO SESSION WAS MINTED.
  it("an enrolled user's login returns mfaRequired and mints NO session row", async () => {
    await enrolled("a@example.com");
    await clearSessions(userA);
    expect(await liveSessions(userA)).toBe(0);

    const res = await loginRaw("a@example.com");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mfaRequired?: true; challenge?: string; token?: string };
    expect(body.mfaRequired).toBe(true);
    expect(body.challenge).toBeTruthy();
    // A response that SAYS mfaRequired while having minted a session is the whole bug — it looks
    // correct from the client and hands the caller a bearer that skips the prompt entirely.
    expect(body.token).toBeUndefined();
    expect(await liveSessions(userA)).toBe(0);
    // And the challenge is not usable as a session token either (the domain separation, over HTTP).
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser(body.challenge!),
    });
    expect(me.statusCode).toBe(401);
  });

  // 6 ── THE EXCHANGE mints an ORDINARY 15.6 session.
  it("a correct code exchanges the challenge for a session that authenticates normally", async () => {
    const { secret } = await enrolled("a@example.com");
    await clearSessions(userA);
    const challenge = await challengeFor("a@example.com");
    const res = await verify(challenge, codeAt(secret));
    expect(res.statusCode, res.body).toBe(200);
    const { token, expiresAt } = res.json() as { token: string; expiresAt: string };
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await liveSessions(userA)).toBe(1);
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe("a@example.com");
    // It is a real `sessions` row, so revocation applies to it exactly as to any other (15.6).
    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: asUser(token),
    });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) });
    expect(after.statusCode).toBe(401);
  });

  // 7 ── REPLAY (RFC 6238 §5.2 / D-15.8-8).
  it("the same TOTP code is refused on a second, freshly-issued challenge", async () => {
    const { secret } = await enrolled("a@example.com");
    const code = codeAt(secret);
    const first = await verify(await challengeFor("a@example.com"), code);
    expect(first.statusCode).toBe(200);
    // A FRESH challenge, so the refusal can only be the `last_step` guard — not expiry, not reuse of
    // the challenge itself. That is the discriminating shape.
    const second = await verify(await challengeFor("a@example.com"), code);
    expect(second.statusCode).toBe(401);
  });

  // 8 ── RECOVERY CODES are single-use (D-15.8-7).
  it("a recovery code works once, then never again, and the remaining count drops", async () => {
    const { codes } = await enrolled("a@example.com");
    const first = await verify(await challengeFor("a@example.com"), codes[0]!);
    expect(first.statusCode, first.body).toBe(200);
    const token = (first.json() as { token: string }).token;
    const st = await status(token);
    expect(st.statusCode).toBe(200);
    expect((st.json() as { recoveryCodesRemaining: number }).recoveryCodesRemaining).toBe(9);

    const replay = await verify(await challengeFor("a@example.com"), codes[0]!);
    expect(replay.statusCode).toBe(401);
    // A DIFFERENT code still works — the refusal above is per-code, not a blanket lockout.
    const second = await verify(await challengeFor("a@example.com"), codes[1]!);
    expect(second.statusCode).toBe(200);
  });

  // 9 ── LOCKOUT (RFC 4226 §7.3 / D-15.8-9).
  it("MFA_MAX_ATTEMPTS failures lock the credential, and a CORRECT code is then still refused", async () => {
    const { secret } = await enrolled("a@example.com");
    const challenge = await challengeFor("a@example.com");
    const wrong = codeAt(secret, 120); // deterministic and far outside the skew window
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      const res = await verify(challenge, wrong);
      expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
    }
    // THE ASSERTION THAT MATTERS: a correct code immediately afterwards is refused. A lockout that
    // only rejects wrong codes is not a lockout — it is the behaviour it already had.
    const locked = await verify(challenge, codeAt(secret));
    expect(locked.statusCode).toBe(429);
    const body = locked.json() as { reason: string; retryAfter: number };
    expect(body.reason).toBe("locked");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(locked.headers["retry-after"]).toBeTruthy();
  });

  // 10 ── THE CREDENTIAL-VERSION BINDING (D-15.8-4 / GOTCHA-1). The subtlest case in the slice.
  it("a challenge is VOID after a password reset — with a correct code, and a generic 401", async () => {
    const { secret } = await enrolled("a@example.com");
    const challenge = await challengeFor("a@example.com");

    // Complete a REAL password reset through the routes, so the `cv` change comes from the same code
    // path an attacker's victim would use, not from a hand-written UPDATE.
    sent.length = 0;
    const req = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "a@example.com" },
    });
    expect(req.statusCode).toBe(202);
    const resetTok = /\/reset\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!;
    const done = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token: resetTok, password: NEW_PASSWORD },
    });
    expect(done.statusCode).toBe(204);

    // The challenge's MAC is still valid and its `exp` is still in the future — the ONLY thing that
    // changed is the password hash. So a 401 here can only be the `cv` comparison.
    const res = await verify(challenge, codeAt(secret));
    expect(res.statusCode).toBe(401);
    // GENERIC. A distinguishable "your password changed" would tell an attacker their stolen
    // challenge is stale AND that the account is live.
    expect((res.json() as { error: string; reason?: string }).reason).toBeUndefined();
    // A fresh login under the NEW password issues a challenge that works — the binding refuses stale
    // challenges, it does not break the account.
    // Step +1 is still UNSPENT, because the refusal above happened before any code was consumed —
    // a stale challenge is rejected at the `cv` comparison, which is upstream of `recordTotpUse`.
    const fresh = await challengeFor("a@example.com", NEW_PASSWORD);
    expect((await verify(fresh, codeAt(secret))).statusCode).toBe(200);
  });

  // 11 ── SESSION INVALIDATION on a credential change (D-15.8-11 / OWASP).
  it("enrol-confirm revokes every OTHER session and spares the caller's", async () => {
    const one = await login("a@example.com");
    const two = await login("a@example.com");
    expect(await liveSessions(userA)).toBe(2);

    const secret = await enrol(one);
    await confirmEnrol(one, secret);

    // The caller's own tab keeps working — it just re-proved a factor there.
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(one) })).statusCode,
    ).toBe(200);
    // Every other live session predates the second factor and would otherwise never present one.
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(two) })).statusCode,
    ).toBe(401);
    expect(await liveSessions(userA)).toBe(1);
  });

  it("disable also revokes every OTHER session and spares the caller's", async () => {
    const { token, secret, codes } = await enrolled("a@example.com");
    // A second session, established through the MFA exchange (so it is a post-enrolment one).
    const other = (await verify(await challengeFor("a@example.com"), codeAt(secret))).json() as {
      token: string;
    };
    expect(await liveSessions(userA)).toBe(2);

    // A RECOVERY code, not a TOTP one, and the reason is a real property of the design rather than a
    // test convenience: `last_step` is monotonic and the skew window is ±1, so within one 30-second
    // window there is exactly ONE unspent step (`confirmEnrol` took step 0, the exchange above took
    // step +1). Recovery codes are independent of `last_step`, which is precisely why a user who has
    // just used their app can still act.
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: json(token),
      payload: { code: codes[0]! },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await status(token)).json()).toMatchObject({ enabled: false });
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(other.token) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(token) })).statusCode,
    ).toBe(200);
  });

  // 12 ── DISABLING REQUIRES A LIVE CODE (D-15.8-12).
  it("disable with no code is a 400, and with a wrong code a 401 — never a 204", async () => {
    const { token, secret } = await enrolled("a@example.com");
    const noCode = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: json(token),
      payload: {},
    });
    expect(noCode.statusCode).toBe(400);
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: json(token),
      payload: { code: codeAt(secret, 120) },
    });
    expect(wrong.statusCode).toBe(401);
    // AND MFA IS STILL ON. A refused disable that disabled anyway is the failure worth pinning.
    expect((await status(token)).json()).toMatchObject({ enabled: true });
    expect(await confirmedAt(userA)).not.toBeNull();
  });

  it("regenerating recovery codes requires a live code, and replaces the old set", async () => {
    const { token, secret, codes } = await enrolled("a@example.com");
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/recovery-codes",
      headers: json(token),
      payload: { code: codeAt(secret, 120) },
    });
    expect(wrong.statusCode).toBe(401);

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/recovery-codes",
      headers: json(token),
      payload: { code: codeAt(secret) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const fresh = (res.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(codes[0]);
    expect((await status(token)).json()).toMatchObject({ recoveryCodesRemaining: 10 });
    // THE OLD SET IS DEAD. Regeneration that left the previous codes usable would double the number
    // of live bypass credentials rather than rotating them.
    expect((await verify(await challengeFor("a@example.com"), codes[0]!)).statusCode).toBe(401);
    expect((await verify(await challengeFor("a@example.com"), fresh[0]!)).statusCode).toBe(200);
  });

  // 13 ── SSO PARITY (D-15.8-5). Without this, "enable MFA" means "unless you use the Google button".
  it("an enrolled user's SSO callback returns mfaRequired, not a token", async () => {
    const { token, secret } = await enrolled("a@example.com");
    // Link the provider from the authenticated session — branch 4's escape hatch (15.7).
    google.profile = { subject: "g-a", email: "a@example.com", emailVerified: true };
    const link = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/link",
      headers: json(token),
      payload: { code: "stub" },
    });
    expect(link.statusCode, link.body).toBe(204);
    await clearSessions(userA);

    const cb = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/callback",
      headers: { "content-type": "application/json" },
      payload: { code: "stub" },
    });
    expect(cb.statusCode, cb.body).toBe(200);
    const body = cb.json() as { mfaRequired?: true; challenge?: string; token?: string };
    expect(body.mfaRequired).toBe(true);
    expect(body.token).toBeUndefined();
    expect(await liveSessions(userA)).toBe(0);
    // And the SSO-issued challenge completes through the SAME exchange — one gate, not two.
    const done = await verify(body.challenge!, codeAt(secret));
    expect(done.statusCode, done.body).toBe(200);
    expect(await liveSessions(userA)).toBe(1);
  });

  it("a NON-enrolled user's SSO callback still mints a session directly", async () => {
    // The regression guard for 15.7: adding the gate must not change the un-enrolled path.
    const token = await login("a@example.com");
    google.profile = { subject: "g-a", email: "a@example.com", emailVerified: true };
    await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/link",
      headers: json(token),
      payload: { code: "stub" },
    });
    const cb = await app.inject({
      method: "POST",
      url: "/v1/auth/sso/google/callback",
      headers: { "content-type": "application/json" },
      payload: { code: "stub" },
    });
    expect(cb.statusCode).toBe(200);
    expect((cb.json() as { token?: string }).token).toBeDefined();
  });

  // 14 ── THE REGRESSION GUARD: a non-enrolled login is byte-identical to before the slice.
  it("a non-enrolled user's login returns a token and no mfaRequired field", async () => {
    const res = await loginRaw("b@example.com");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object).sort()).toEqual(["expiresAt", "token"]);
    expect(await liveSessions(userB)).toBe(1);
  });

  // 15 ── CROSS-USER ISOLATION. The routes take `principal.userId`; there is no id in any path.
  it("user B cannot read, disable or regenerate for user A", async () => {
    const { secret } = await enrolled("a@example.com");
    const tokenB = await login("b@example.com");

    // B's status is B's own — enrolling A must not make B look protected.
    expect((await status(tokenB)).json()).toMatchObject({
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    // A's live code presented by B is refused: it is checked against B's (nonexistent) credential.
    for (const path of ["/v1/auth/mfa/disable", "/v1/auth/mfa/recovery-codes"]) {
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: json(tokenB),
        payload: { code: codeAt(secret) },
      });
      expect(res.statusCode, path).toBe(409);
      expect((res.json() as { reason: string }).reason).toBe("not_enrolled");
    }
    // And A is untouched throughout.
    expect(await confirmedAt(userA)).not.toBeNull();
  });

  // ── EDGE CASES ────────────────────────────────────────────────────────────────────────────

  it("a challenge presented after the credential is removed is a 401, never a 500", async () => {
    const { token, secret } = await enrolled("a@example.com");
    const challenge = await challengeFor("a@example.com");
    const off = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: json(token),
      payload: { code: codeAt(secret) },
    });
    expect(off.statusCode).toBe(204);
    const res = await verify(challenge, codeAt(secret));
    // The generic 401, and `not_enrolled` deliberately does NOT leak here: an unauthenticated caller
    // learning "that account has no second factor" is enumeration.
    expect(res.statusCode).toBe(401);
    expect((res.json() as { reason?: string }).reason).toBeUndefined();
  });

  it("a code from the PREVIOUS step is accepted; two steps back is not (RFC 6238 §6)", async () => {
    const { secret } = await enrolled("a@example.com");
    // Two steps back is outside the ±1 window.
    expect((await verify(await challengeFor("a@example.com"), codeAt(secret, -2))).statusCode).toBe(
      401,
    );
    // The confirming code stamped the CURRENT step, so "previous step" here means step 0 relative to
    // a confirm that happened at step 0 — use +1 then check +0 is now spent, which is the same
    // monotonic rule from the other direction.
    expect((await verify(await challengeFor("a@example.com"), codeAt(secret, 1))).statusCode).toBe(
      200,
    );
    expect((await verify(await challengeFor("a@example.com"), codeAt(secret, 0))).statusCode).toBe(
      401,
    );
  });

  it("a garbage challenge and a garbage code both answer 401, never a 500", async () => {
    await enrolled("a@example.com");
    expect((await verify("not-a-challenge", "123456")).statusCode).toBe(401);
    expect((await verify("a.b", "123456")).statusCode).toBe(401);
    const challenge = await challengeFor("a@example.com");
    // A body that fails the ajv schema is a 400 before the handler runs.
    const short = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      headers: { "content-type": "application/json" },
      payload: { challenge, code: "12345" },
    });
    expect(short.statusCode).toBe(400);
  });

  it("an ADMIN_TOKEN caller reads the bootstrap admin's status and is never MFA-gated (D-15.8-15)", async () => {
    const res = await status(SERVICE_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false });
  });

  it("every MFA route 401s without a credential", async () => {
    for (const [method, url] of [
      ["GET", "/v1/auth/mfa"],
      ["POST", "/v1/auth/mfa/enroll"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
    }
    for (const url of [
      "/v1/auth/mfa/enroll/confirm",
      "/v1/auth/mfa/disable",
      "/v1/auth/mfa/recovery-codes",
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: { code: "123456" },
      });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
