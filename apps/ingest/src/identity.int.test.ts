import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  apiKeys,
  createDb,
  ensurePersonalOrg,
  invites,
  machines,
  memberships,
  setUserPassword,
  withOrg,
} from "@420ai/db";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import type { Mailer } from "./delivery/mailer.js";
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
const NEW_PASSWORD = "a-brand-new-passphrase";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in identity tests", "unavailable");
  },
};

/**
 * M15 15.5 — THE SLICE'S PROOF. A TWO-ROLE, MULTI-USER, HTTP suite.
 *
 * TWO POSTGRES ROLES, for the reason CLAUDE.md states as `bypassed ≠ enforced`: the `owner` handle
 * (DATABASE_URL_TEST) does setup only, because TRUNCATE requires table ownership, and every
 * assertion runs against an app built on `appRole` (DATABASE_URL_TEST_APP), a non-owner with
 * `rolbypassrls = false`. Against the owner the 0016/0017 restrictive policies are INERT, so an
 * owner-connected suite would report green while enforcing nothing. Test 1 is why the rest mean
 * anything.
 *
 * THE MAILER IS INJECTED as a capturing fake, so no test opens SMTP and the assertions can read the
 * actual token out of the actual message body — which is the only way to prove the mailed path
 * end-to-end rather than trusting the route's return value.
 *
 * Every numbered group below corresponds to a decision this slice made. A missing test here is an
 * unproven decision, so they are labelled with the decision they pin.
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

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.5 identity core (two-role, multi-user)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let userOwner: string;
  let userAdmin: string;
  let userViewer: string;
  let machineOwned: string;

  /** Every message the routes "sent", newest last. Cleared in `beforeEach`. */
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
      // selfSignupEnabled deliberately OMITTED — test group 8 asserts the default is OFF.
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
    expect(res.statusCode, `login for ${email}`).toBe(200);
    return (res.json() as { token: string }).token;
  }

  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...asUser(token), "content-type": "application/json" });

  /** Pull the invite token out of the last mailed message's link. */
  function invitedToken(mail: SentMail): string {
    const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text);
    expect(m, `no invite link in mail body:\n${mail.text}`).not.toBeNull();
    return m![1]!;
  }

  /** Pull the reset token out of the last mailed message's link. */
  function resetToken(mail: SentMail): string {
    const m = /\/reset\/([A-Za-z0-9_-]+)/.exec(mail.text);
    expect(m, `no reset link in mail body:\n${mail.text}`).not.toBeNull();
    return m![1]!;
  }

  /** Invite `email` as `role` through the real route, returning the mailed token. */
  async function inviteAndCollect(bearer: string, email: string, role: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(bearer),
      payload: { email, role },
    });
    expect(res.statusCode, `invite ${email} as ${role}: ${res.body}`).toBe(200);
    expect(sent).toHaveLength(1);
    return invitedToken(sent[0]!);
  }

  async function userCount(email: string): Promise<number> {
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from users where lower(email) = ${email.toLowerCase()}`,
    );
    return r.rows[0]!.n;
  }

  beforeEach(async () => {
    sent.length = 0;
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    userOwner = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    userAdmin = await setUserPassword(owner.db, "admin@example.com", hashPassword(PASSWORD));
    userViewer = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));

    // GOTCHA-1 as a seeding rule: `setUserPassword` calls `ensurePersonalOrg`, so every user above
    // already holds an `owner` membership in their own personal org. The colleagues are therefore
    // MOVED into org A rather than given a SECOND membership — `findPrincipalByEmail` resolves the
    // FIRST membership by (created_at, id), so an inserted row would be shadowed by the personal
    // `owner` one and every role assertion below would silently be testing an owner.
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "admin" })
      .where(eq(memberships.userId, userAdmin));
    await owner.db
      .update(memberships)
      .set({ orgId: orgA, role: "viewer" })
      .where(eq(memberships.userId, userViewer));

    // A SECOND org (the bootstrap admin's) — the cross-tenant control.
    const adminId = (
      await owner.db.execute<{ id: string }>(sql`select id from users where email = ${ADMIN_EMAIL}`)
    ).rows[0]!.id;
    orgB = await ensurePersonalOrg(owner.db, adminId, ADMIN_EMAIL);
    expect(orgA).not.toBe(orgB);

    // A machine in org A, so an invited colleague's monitor has something to show.
    const [m] = await owner.db
      .insert(machines)
      .values({ orgId: orgA, userId: userOwner, name: "owner-laptop" })
      .returning({ id: machines.id });
    machineOwned = m!.id;
  });

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

  // 2 ── THE END-TO-END INVITE. Every hop is real: the route mails, the assertion reads the token
  //      out of the message body, the preview resolves the org, and the accepted session works.
  it("an admin invites a colleague who accepts by mail and lands as a working member", async () => {
    const admin = await login("admin@example.com");
    const token = await inviteAndCollect(admin, "new@example.com", "member");
    expect(sent[0]!.to).toBe("new@example.com");

    // PREVIEW: names the org, and does NOT echo the token back.
    const preview = await app.inject({ method: "GET", url: `/v1/auth/invites/${token}` });
    expect(preview.statusCode).toBe(200);
    const previewed = preview.json() as Record<string, unknown>;
    expect(previewed.email).toBe("new@example.com");
    expect(previewed.role).toBe("member");
    expect(previewed.orgName).toBe("owner@example.com"); // the personal org's seeded name
    expect(JSON.stringify(previewed)).not.toContain(token);

    // ACCEPT: returns a session, so the invitee is logged in without a second round trip.
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/invites/accept",
      headers: { "content-type": "application/json" },
      payload: { token, password: NEW_PASSWORD },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const session = (accepted.json() as { token: string }).token;

    // …and that session is a REAL one: it identifies the invitee on a gated route.
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: asUser(session) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ email: "new@example.com" });

    // The org now has FOUR people (owner, admin, viewer, and the newcomer).
    const members = await app.inject({ method: "GET", url: "/v1/members", headers: asUser(admin) });
    expect(members.statusCode).toBe(200);
    const emails = (members.json() as { members: { email: string }[] }).members.map((m) => m.email);
    expect(emails).toContain("new@example.com");
    expect(emails).toHaveLength(4);
  });

  it("the invite is single-use: a second accept with the same token is 410 'accepted'", async () => {
    const admin = await login("admin@example.com");
    const token = await inviteAndCollect(admin, "new@example.com", "member");
    const accept = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/invites/accept",
        headers: { "content-type": "application/json" },
        payload: { token, password: NEW_PASSWORD },
      });
    expect((await accept()).statusCode).toBe(200);
    const second = await accept();
    expect(second.statusCode).toBe(410);
    expect((second.json() as { reason: string }).reason).toBe("accepted");
  });

  // 3 ── THE GOTCHA-1 REGRESSION. THIS is the test that fails if the accept path ever reaches for
  //      `setUserPassword` instead of `createUserWithPassword`: that call runs `ensurePersonalOrg`,
  //      and because `findPrincipalByEmail` resolves the FIRST membership by (created_at, id), the
  //      personal `owner` membership would shadow the invited one forever. The invite would read as
  //      working while the user resolved to their own EMPTY org at the WRONG rung. Verified by
  //      swapping the call locally and watching this fail; a test that never failed proves nothing.
  it("an accepted invitee has EXACTLY ONE membership, in the INVITING org, at the invited rung", async () => {
    const admin = await login("admin@example.com");
    const token = await inviteAndCollect(admin, "new@example.com", "member");
    await app.inject({
      method: "POST",
      url: "/v1/auth/invites/accept",
      headers: { "content-type": "application/json" },
      payload: { token, password: NEW_PASSWORD },
    });

    const rows = await owner.db.execute<{ org_id: string; role: string }>(
      sql`select m.org_id, m.role from memberships m
          join users u on u.id = m.user_id
          where u.email = 'new@example.com'`,
    );
    expect(rows.rows).toHaveLength(1); // ← ONE. Two means a personal org was created first.
    expect(rows.rows[0]!.org_id).toBe(orgA);
    expect(rows.rows[0]!.role).toBe("member");

    // …and the behavioural half: driving a REAL request as them shows ORG A's machine. A shadowed
    // membership would return an empty monitor here while every row-level assertion above still
    // looked plausible.
    const monitor = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: asUser(await login("new@example.com", NEW_PASSWORD)),
    });
    expect(monitor.statusCode).toBe(200);
    expect((monitor.json() as { machines: { id: string }[] }).machines.map((m) => m.id)).toEqual([
      machineOwned,
    ]);
  });

  // 4 ── THE ESCALATION GUARD (D-15.5-11). An admin invites up to `admin`, never `owner`.
  it("an admin inviting role 'owner' is 403 and writes no invite row", async () => {
    const admin = await login("admin@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(admin),
      payload: { email: "escalated@example.com", role: "owner" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "cannot grant a role above your own" });
    expect(await owner.db.select().from(invites)).toHaveLength(0);
    expect(sent).toHaveLength(0);

    // …while an OWNER may, so the refusal above is the LADDER and not a blanket ban on the rung.
    const asOwner = await login("owner@example.com");
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(asOwner),
      payload: { email: "co-owner@example.com", role: "owner" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("an admin PATCHing a member to 'owner' is 403 (the same guard on the re-role path)", async () => {
    const admin = await login("admin@example.com");
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: json(admin),
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(403);
    // …and a rung at or below their own goes through.
    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: json(admin),
      payload: { role: "admin" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { member: { role: string } }).member.role).toBe("admin");
  });

  // 5 ── EXISTING-USER REJECTION (D-15.5-9). Loud, because the alternative is a silent no-op.
  it("inviting an email that ALREADY has a user is 409, and no invite row is written", async () => {
    const admin = await login("admin@example.com");
    // `viewer@example.com` is already in org A…
    const member = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(admin),
      payload: { email: "viewer@example.com", role: "member" },
    });
    expect(member.statusCode).toBe(409);
    expect(member.json()).toEqual({ error: "already a member" });

    // …and the bootstrap admin has a user row in ANOTHER org, which is the harder case: the
    // membership would be created and then permanently shadowed (see test 3).
    const elsewhere = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(admin),
      payload: { email: ADMIN_EMAIL, role: "member" },
    });
    expect(elsewhere.statusCode).toBe(409);
    // M15 15.10 (D-15.10-1) — the body no longer names a milestone at all. It used to read
    // "multi-org membership lands in 15.10", which was both wrong (multi-org went to M20) and
    // aimed at the wrong reader: the next person to see a 409 body is an API consumer, not a
    // maintainer, and a slice number tells them nothing they can act on.
    expect((elsewhere.json() as { error: string }).error).toMatch(/only one organization/i);
    expect((elsewhere.json() as { error: string }).error).not.toMatch(/15\.10/);

    expect(await owner.db.select().from(invites)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("TWO pending invites for one email still yield exactly ONE membership", async () => {
    // THE INVARIANT THE ROUTE ACTUALLY RELIES ON, pinned because the invite route does NOT enforce
    // single-pending-invite. Its three checks share one transaction, which buys atomicity but NOT
    // isolation: under READ COMMITTED two overlapping invites both pass the pending check and both
    // insert (measured during the PR review). `invites.email` is deliberately not unique, so nothing
    // at that layer catches it.
    //
    // What keeps that benign is HERE, one layer down — the ACCEPT path's own `findUserIdByEmail`
    // check with `users.email`'s unique index behind it. This test is therefore the thing standing
    // between a duplicate pending invite and a duplicate account, which is why it exists rather than
    // a partial unique index on `invites`.
    const admin = await login("admin@example.com");
    const tokenA = await inviteAndCollect(admin, "new@example.com", "member");

    // Simulate the losing half of the race: a SECOND pending invite for the same address, inserted
    // the way an overlapping transaction would have.
    const secondPlain = "second-invite-token-for-the-same-email";
    await owner.db.insert(invites).values({
      orgId: orgA,
      email: "new@example.com",
      role: "admin", // deliberately a HIGHER rung, so a wrongly-redeemed second token would be visible
      tokenHash: createHash("sha256").update(secondPlain).digest("hex"),
      invitedByUserId: userAdmin,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const accept = (token: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/invites/accept",
        headers: { "content-type": "application/json" },
        payload: { token, password: NEW_PASSWORD },
      });

    expect((await accept(tokenA)).statusCode).toBe(200);
    // The loser cannot create a second account, and specifically cannot smuggle in the `admin` rung.
    const second = await accept(secondPlain);
    expect(second.statusCode).toBe(409);

    const rows = await owner.db.execute<{ n: number; role: string }>(
      sql`select count(*)::int as n, min(m.role) as role from memberships m
          join users u on u.id = m.user_id where u.email = 'new@example.com'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
    expect(rows.rows[0]!.role).toBe("member"); // the FIRST invite's rung, not the second's
    expect(await userCount("new@example.com")).toBe(1);
  });

  it("a second invite for the same PENDING address is 409 rather than a duplicate token", async () => {
    const admin = await login("admin@example.com");
    await inviteAndCollect(admin, "new@example.com", "member");
    const again = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(admin),
      payload: { email: "new@example.com", role: "member" },
    });
    expect(again.statusCode).toBe(409);
    expect(await owner.db.select().from(invites)).toHaveLength(1);
  });

  // 4c ── THE OUTRANK GUARD. Added by the 15.5 code review, which found that D-15.5-11 as written
  //       only covered GRANTING a rung and said nothing about acting ON a member above you. Before
  //       the fix an admin could PATCH an owner to viewer (200) and DELETE an owner outright (204) —
  //       a privilege inversion, since the whole point of an ordered ladder is that a lower rung
  //       cannot reach up. The last-owner guard bounded it to "never zero owners", which is not the
  //       same promise at all.
  it("an admin may NOT demote an owner, and may NOT remove one", async () => {
    // Give org A a second owner so the last-owner guard cannot be what produces the refusal — this
    // must fail on the RANK, not on the count.
    const asOwner = await login("owner@example.com");
    const promoted = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: json(asOwner),
      payload: { role: "owner" },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);

    const admin = await login("admin@example.com");
    const demote = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: json(admin),
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(403);
    expect(demote.json()).toEqual({ error: "cannot modify a member who outranks you" });

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userViewer}`,
      headers: asUser(admin),
    });
    expect(remove.statusCode).toBe(403);

    // The victim is untouched: still an owner, still a member.
    const [row] = await owner.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userViewer));
    expect(row!.role).toBe("owner");
  });

  it("an owner MAY act on another owner (equal rank clears the guard)", async () => {
    // The other half: a guard that refused equal rank would make a co-owner unremovable, so this is
    // what stops the fix above from being over-restrictive.
    const asOwner = await login("owner@example.com");
    const promoted = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userAdmin}`,
      headers: json(asOwner),
      payload: { role: "owner" },
    });
    expect(promoted.statusCode).toBe(200);

    const demoted = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userAdmin}`,
      headers: json(asOwner),
      payload: { role: "member" },
    });
    expect(demoted.statusCode, demoted.body).toBe(200);
    expect((demoted.json() as { member: { role: string } }).member.role).toBe("member");
  });

  it("an admin may still act on a member and a viewer (the guard is a ceiling, not a wall)", async () => {
    const admin = await login("admin@example.com");
    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userViewer}`,
      headers: json(admin),
      payload: { role: "member" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userViewer}`,
      headers: asUser(admin),
    });
    expect(removed.statusCode).toBe(204);
  });

  // 6 ── BOTH LAYERS, as 15.4 did: the route gate AND the RLS backstop underneath it.
  it("a viewer cannot invite — 403 at the route AND an RLS rejection at the database", async () => {
    const viewer = await login("viewer@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v1/members/invite",
      headers: json(viewer),
      payload: { email: "new@example.com", role: "member" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient role" });

    // The backstop, WITH the route gate bypassed entirely — this never touches HTTP, so no
    // `authorized()` call can be responsible for it.
    await expectRlsRejection(
      withOrg(appRole.db, orgA, "viewer", (tx) =>
        tx.insert(invites).values({
          orgId: orgA,
          email: "backstopped@example.com",
          role: "member",
          tokenHash: "not-a-real-hash-viewer",
          invitedByUserId: userOwner,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    // …while the SAME statement under an admin context succeeds. Without this half, a broken ORG
    // policy (rejecting everything) would look like a working ROLE policy.
    await expect(
      withOrg(appRole.db, orgA, "admin", (tx) =>
        tx.insert(invites).values({
          orgId: orgA,
          email: "permitted@example.com",
          role: "member",
          tokenHash: "not-a-real-hash-admin",
          invitedByUserId: userOwner,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).resolves.toBeDefined();
  });

  // 7 ── THE LAST-OWNER GUARD (D-15.5-12) over HTTP.
  it("removing the org's SOLE owner is 409 and the membership survives", async () => {
    // THE ACTOR MUST BE THE OWNER. Since the review's outrank fix, an ADMIN targeting an owner is
    // refused 403 by the rank check BEFORE the last-owner guard is ever consulted — so an admin actor
    // here would assert the wrong thing while still looking red-then-green. The sole owner removing
    // THEMSELVES is the only way to reach this guard through HTTP, and it is also the realistic case
    // (someone tidying up their own account).
    const asOwner = await login("owner@example.com");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userOwner}`,
      headers: asUser(asOwner),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("last_owner");

    const still = await owner.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userOwner));
    expect(still).toHaveLength(1);
    expect(still[0]!.role).toBe("owner");

    // …and an ordinary member CAN be removed, proving the 409 was the guard and not a broken route.
    const admin = await login("admin@example.com");
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userViewer}`,
      headers: asUser(admin),
    });
    expect(removed.statusCode).toBe(204);
  });

  it("an admin removing an owner is refused by RANK (403) before the last-owner guard (409)", async () => {
    // The ORDER of the two refusals is itself worth pinning: a 409 here would mean the rank check had
    // been bypassed and the org was saved only by the owner count — a much weaker promise, and one
    // that evaporates the moment a second owner exists.
    const admin = await login("admin@example.com");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/members/${userOwner}`,
      headers: asUser(admin),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "cannot modify a member who outranks you" });
  });

  it("demoting the sole owner is 409 too (the guard covers both mutations)", async () => {
    const asOwner = await login("owner@example.com");
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/members/${userOwner}`,
      headers: json(asOwner),
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { reason: string }).reason).toBe("last_owner");
  });

  // 8 ── SELF-SIGNUP (D-15.5-5 / D-15.5-6). The default is the most consequential in the slice.
  it("POST /v1/auth/signup is 403 on the DEFAULT app (invite-only unless opted in)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      headers: { "content-type": "application/json" },
      payload: { email: "walkin@example.com", password: NEW_PASSWORD },
    });
    // 403, not 404: the route's existence is public knowledge (this is open source), so pretending
    // it is absent buys nothing and makes a misconfiguration undiagnosable.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "self-signup is disabled" });
    expect(await userCount("walkin@example.com")).toBe(0);
  });

  it("with signup ENABLED the new user owns a BRAND-NEW org, never an existing one", async () => {
    const open = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      mailer: fakeMailer,
      selfSignupEnabled: true,
      logger: false,
    });
    await open.ready();
    try {
      const res = await open.inject({
        method: "POST",
        url: "/v1/auth/signup",
        headers: { "content-type": "application/json" },
        payload: { email: "walkin@example.com", password: NEW_PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { token: string }).token).toBeTruthy();

      // D-15.5-6: ONE membership, `owner`, and in NEITHER existing org. A signup that joined the
      // first org it found would hand every passer-by a tenant.
      const rows = await owner.db.execute<{ org_id: string; role: string }>(
        sql`select m.org_id, m.role from memberships m
            join users u on u.id = m.user_id
            where u.email = 'walkin@example.com'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.role).toBe("owner");
      expect(rows.rows[0]!.org_id).not.toBe(orgA);
      expect(rows.rows[0]!.org_id).not.toBe(orgB);

      // …and they see their OWN empty org, not org A's machine.
      const monitor = await open.inject({
        method: "GET",
        url: "/v1/monitor",
        headers: asUser((res.json() as { token: string }).token),
      });
      expect(monitor.statusCode).toBe(200);
      expect((monitor.json() as { machines: unknown[] }).machines).toEqual([]);
    } finally {
      await open.close();
    }
  });

  /**
   * M15 15.9 (PR-review finding) — A PASSWORD RESET MUST REVOKE API KEYS.
   *
   * D-15.9-9 says a password CHANGE must not (a routine rotation breaking the desktop app and every
   * cron is worse than the threat). A RESET is the opposite case: this route's own comment names the
   * threat as "somebody took over my account, let me reset my password", and that is precisely when
   * the attacker has had the password long enough to mint a `k420_` key. A key is not derived from
   * the password, never expires by default, and survives every session revoke — so leaving it live
   * hands the attacker a persistence primitive that OUTLIVES the remediation.
   *
   * Asserted on the ROW, not just the 401: without the row check this would pass anyway today,
   * because a reset also revokes sessions and the key's owner still resolves. The row is the
   * designed guarantee.
   */
  it("a password RESET revokes the user's API keys, not just their sessions", async () => {
    const session = await login("viewer@example.com");
    const minted = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: json(session),
      payload: { name: "attacker-persistence", currentPassword: PASSWORD },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const apiKey = (minted.json() as { token: string }).token;

    // POSITIVE FIRST: the key really works before the reset.
    const before = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(before.statusCode, "the key must work before the reset").toBe(200);

    await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "viewer@example.com" },
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token: resetToken(sent[sent.length - 1]!), password: NEW_PASSWORD },
    });
    expect(confirm.statusCode, confirm.body).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(after.statusCode, "a reset must kill the key").toBe(401);

    const rows = await owner.db.select().from(apiKeys).where(eq(apiKeys.userId, userViewer));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt, "the ROW must be stamped, not merely orphaned").not.toBe(null);
  });

  // 9 ── PASSWORD RESET ROUND TRIP.
  it("a reset request mails a token that swaps the password: old 401s, new 200s", async () => {
    const request = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "viewer@example.com" },
    });
    expect(request.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    const token = resetToken(sent[0]!);

    const confirm = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token, password: NEW_PASSWORD },
    });
    expect(confirm.statusCode, confirm.body).toBe(204);

    const withOld = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email: "viewer@example.com", password: PASSWORD },
    });
    expect(withOld.statusCode).toBe(401);
    // `login` itself asserts 200, so this call IS the assertion.
    await login("viewer@example.com", NEW_PASSWORD);
  });

  it("a reset request for an UNKNOWN email is ALSO 202 and writes no token row (D-15.5-7)", async () => {
    // Pinned deliberately so nobody "fixes" this into a 404: a differing status here would turn the
    // endpoint into a user-enumeration oracle (OWASP: return a consistent message).
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "nobody@nowhere.test" },
    });
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
    const rows = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from password_reset_tokens`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  // 10 ── SINGLE USE. A leaked token must not be replayable.
  it("a reset token is single-use: confirming twice returns 410 the second time", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset",
      headers: { "content-type": "application/json" },
      payload: { email: "viewer@example.com" },
    });
    const token = resetToken(sent[0]!);
    const confirm = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        headers: { "content-type": "application/json" },
        payload: { token, password: NEW_PASSWORD },
      });
    expect((await confirm()).statusCode).toBe(204);
    const second = await confirm();
    expect(second.statusCode).toBe(410);
    expect((second.json() as { reason: string }).reason).toBe("consumed");
  });

  it("a reset request 503s when NO mailer is configured (D-15.5-10's asymmetry)", async () => {
    // The UNAUTHENTICATED half of D-15.5-10. The admin-gated invite route hands the token back in
    // its response with no mailer; this route must NOT — returning a reset token to an anonymous
    // caller would be a complete account-takeover primitive.
    const noMail = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      logger: false,
    });
    await noMail.ready();
    try {
      const res = await noMail.inject({
        method: "POST",
        url: "/v1/auth/password-reset",
        headers: { "content-type": "application/json" },
        payload: { email: "viewer@example.com" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/no mail transport/);
      expect(JSON.stringify(body)).not.toMatch(/token/i);

      // …and the INVITE route on the same mailer-less app DOES return the token (the other half).
      const admin = await login("admin@example.com");
      const invited = await noMail.inject({
        method: "POST",
        url: "/v1/members/invite",
        headers: json(admin),
        payload: { email: "new@example.com", role: "member" },
      });
      expect(invited.statusCode, invited.body).toBe(200);
      const invitedBody = invited.json() as { mailed: boolean; token?: string };
      expect(invitedBody.mailed).toBe(false);
      expect(invitedBody.token).toBeTruthy();
    } finally {
      await noMail.close();
    }
  });

  it("a BROKEN mailer hands the token back instead of stranding the invite", async () => {
    // Found by the 15.5 code review. The invite row commits BEFORE the send, and only its sha256 is
    // stored — so an unhandled send failure used to 500 with the token gone forever, and every retry
    // answered 409 "already pending". A transient SMTP blip turned the onboarding route into a dead
    // end. It now degrades to the no-mailer branch, which D-15.5-10 already sanctions for this
    // ADMIN-GATED route.
    const broken = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      sessionSecret: SESSION_SECRET,
      analysisProvider: stubProvider,
      mailer: {
        appBaseUrl: "http://test.local",
        async send() {
          throw new Error("smtp down");
        },
      },
      logger: false,
    });
    await broken.ready();
    try {
      const admin = await login("admin@example.com");
      const res = await broken.inject({
        method: "POST",
        url: "/v1/members/invite",
        headers: json(admin),
        payload: { email: "new@example.com", role: "member" },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { mailed: boolean; mailError?: boolean; token?: string };
      expect(body.mailed).toBe(false);
      expect(body.mailError).toBe(true); // distinguishes "SMTP broke" from "no SMTP configured"
      expect(body.token).toBeTruthy();

      // …and the token handed back is USABLE, which is the whole point of not stranding it.
      const accepted = await broken.inject({
        method: "POST",
        url: "/v1/auth/invites/accept",
        headers: { "content-type": "application/json" },
        payload: { token: body.token, password: NEW_PASSWORD },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
    } finally {
      await broken.close();
    }
  });

  it("a second reset request INVALIDATES the first token (one live token per user)", async () => {
    // OWASP's Forgot-Password rule, and the 15.5 review measured that two requests previously left
    // TWO tokens usable for the full hour — multiplying the number of stale links the 1-hour TTL is
    // the only bound on.
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/password-reset",
        headers: { "content-type": "application/json" },
        payload: { email: "viewer@example.com" },
      });
    await request();
    const firstToken = resetToken(sent[0]!);
    await request();
    const secondToken = resetToken(sent[1]!);
    expect(secondToken).not.toBe(firstToken);

    const live = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from password_reset_tokens where consumed_at is null`,
    );
    expect(live.rows[0]!.n, "exactly ONE live reset token per user").toBe(1);

    // The superseded token is dead…
    const stale = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token: firstToken, password: NEW_PASSWORD },
    });
    expect(stale.statusCode).toBe(410);
    expect((stale.json() as { reason: string }).reason).toBe("consumed");

    // …and the newest one still works, so invalidation did not break the feature.
    const fresh = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      headers: { "content-type": "application/json" },
      payload: { token: secondToken, password: NEW_PASSWORD },
    });
    expect(fresh.statusCode, fresh.body).toBe(204);
  });

  // 11 ── D-M15-8 CLOSURE. The count is the real assertion; the status code alone would pass even
  //       if the row were created and the subsequent lookup then failed.
  it("POST /v1/pairing-codes for a NON-MEMBER email is 404 and creates ZERO users rows", async () => {
    const admin = await login("admin@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: json(admin),
      payload: { email: "stranger@nowhere.test" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no such member in this organization" });
    expect(await userCount("stranger@nowhere.test")).toBe(0); // ← THE assertion

    // …and the same for the `userId` path, which would otherwise keep the primitive alive one
    // parameter to the left: the bootstrap admin is a real user, in ANOTHER org.
    const adminUserId = (
      await owner.db.execute<{ id: string }>(sql`select id from users where email = ${ADMIN_EMAIL}`)
    ).rows[0]!.id;
    const byId = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: json(admin),
      payload: { userId: adminUserId },
    });
    expect(byId.statusCode).toBe(404);

    // …while a code for a genuine colleague still issues, so the 404s above are a boundary and not
    // a broken route.
    const ok = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: json(admin),
      payload: { email: "owner@example.com" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { code: string }).code).toBeTruthy();
  });

  // 12 ── EMAIL CASE-INSENSITIVITY, END TO END (D-15.5-3).
  it("a mixed-case invite yields ONE lowercase account that logs in either way", async () => {
    const admin = await login("admin@example.com");
    const token = await inviteAndCollect(admin, "New@Example.com", "member");
    // The invite row — and therefore the mail — already carries the normalized address.
    expect(sent[0]!.to).toBe("new@example.com");

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/invites/accept",
      headers: { "content-type": "application/json" },
      payload: { token, password: NEW_PASSWORD },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    // EXACTLY ONE account, not two case variants — the half of the D-M15-8 chain where
    // case-variance gets an attacker a second row the victim cannot see.
    expect(await userCount("new@example.com")).toBe(1);
    const stored = await owner.db.execute<{ email: string }>(
      sql`select email from users where lower(email) = 'new@example.com'`,
    );
    expect(stored.rows[0]!.email).toBe("new@example.com");

    // …and BOTH spellings log in to the same account.
    await login("new@example.com", NEW_PASSWORD);
    await login("NEW@EXAMPLE.COM", NEW_PASSWORD);
  });

  // 13 ── THE INVITE ERROR SURFACE. Four distinct reasons, all 410, so a client can tell them apart
  //       without parsing prose.
  it("unknown / revoked / expired invite tokens are each 410 with a distinct reason", async () => {
    const admin = await login("admin@example.com");

    const unknown = await app.inject({ method: "GET", url: "/v1/auth/invites/not-a-token" });
    expect(unknown.statusCode).toBe(410);
    expect((unknown.json() as { reason: string }).reason).toBe("unknown");

    // REVOKED, through the real route.
    const revokedToken = await inviteAndCollect(admin, "revoked@example.com", "member");
    const [row] = await owner.db.select({ id: invites.id }).from(invites);
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/invites/${row!.id}`,
      headers: asUser(admin),
    });
    expect(revoke.statusCode).toBe(204);
    const afterRevoke = await app.inject({
      method: "GET",
      url: `/v1/auth/invites/${revokedToken}`,
    });
    expect(afterRevoke.statusCode).toBe(410);
    expect((afterRevoke.json() as { reason: string }).reason).toBe("revoked");

    // EXPIRED — back-date the row rather than waiting seven days.
    sent.length = 0;
    const expiredToken = await inviteAndCollect(admin, "expired@example.com", "member");
    await owner.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.email, "expired@example.com"));
    const afterExpiry = await app.inject({
      method: "GET",
      url: `/v1/auth/invites/${expiredToken}`,
    });
    expect(afterExpiry.statusCode).toBe(410);
    expect((afterExpiry.json() as { reason: string }).reason).toBe("expired");
  });

  it("a revoked invite stops being listed and a bad invite id is 400, not a 500", async () => {
    const admin = await login("admin@example.com");
    await inviteAndCollect(admin, "new@example.com", "member");
    const pending = await app.inject({ method: "GET", url: "/v1/invites", headers: asUser(admin) });
    expect((pending.json() as { invites: unknown[] }).invites).toHaveLength(1);
    // The listing must not carry the credential digest or the tenancy column.
    expect(Object.keys((pending.json() as { invites: object[] }).invites[0]!).sort()).toEqual([
      "acceptedAt",
      "createdAt",
      "email",
      "expiresAt",
      "id",
      "invitedByUserId",
      "role",
    ]);

    // A malformed id is a 400 via `isUuid`, never a Postgres uuid-cast 500.
    const malformed = await app.inject({
      method: "DELETE",
      url: "/v1/invites/not-a-uuid",
      headers: asUser(admin),
    });
    expect(malformed.statusCode).toBe(400);
    // A well-formed but unknown id is a 404.
    const missing = await app.inject({
      method: "DELETE",
      url: "/v1/invites/00000000-0000-0000-0000-000000000000",
      headers: asUser(admin),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("an admin of ANOTHER org cannot see or revoke org A's invites", async () => {
    const admin = await login("admin@example.com");
    await inviteAndCollect(admin, "new@example.com", "member");
    const [row] = await owner.db.select({ id: invites.id }).from(invites);

    // The bootstrap admin owns org B.
    const other = await login(ADMIN_EMAIL);
    const listed = await app.inject({ method: "GET", url: "/v1/invites", headers: asUser(other) });
    expect((listed.json() as { invites: unknown[] }).invites).toEqual([]);
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/invites/${row!.id}`,
      headers: asUser(other),
    });
    expect(revoke.statusCode).toBe(404);
    // …and the invite is untouched.
    const [after] = await owner.db.select({ revokedAt: invites.revokedAt }).from(invites);
    expect(after!.revokedAt).toBeNull();
  });

  // 14 ── CHANGE-OWN-PASSWORD.
  it("changing your own password requires the CURRENT one and then takes effect", async () => {
    const viewer = await login("viewer@example.com");
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: json(viewer),
      payload: { currentPassword: "not-my-password", newPassword: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: json(viewer),
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(right.statusCode, right.body).toBe(204);
    await login("viewer@example.com", NEW_PASSWORD);

    // D-15.5-13: the OLD session is still valid. Sessions are stateless HMACs until 15.6
    // (D-M15-12), so there is no revocation to attempt here — pinned so the deferral is a recorded
    // decision rather than an accident, and so 15.6 has a test to flip.
    const stillValid = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: asUser(viewer),
    });
    expect(stillValid.statusCode).toBe(200);
  });

  it("GET /v1/members is readable by a viewer but the mutations are not", async () => {
    const viewer = await login("viewer@example.com");
    const read = await app.inject({ method: "GET", url: "/v1/members", headers: asUser(viewer) });
    expect(read.statusCode).toBe(200);
    for (const [method, url] of [
      ["GET", "/v1/invites"],
      ["DELETE", `/v1/members/${userAdmin}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: asUser(viewer) });
      expect(res.statusCode, `viewer ${method} ${url}`).toBe(403);
    }
  });
});
