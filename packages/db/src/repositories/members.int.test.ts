import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { memberships } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { setUserPassword } from "./users.js";
import {
  MemberError,
  findMemberByEmail,
  findMemberByUserId,
  listMembers,
  removeMember,
  setMemberRole,
} from "./members.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const HASH = "scrypt$c2FsdA$ZGs"; // never verified here — these tests never log in

/**
 * M15 15.5 — the REPOSITORY-level proof for member management. TWO ROLES, and per CLAUDE.md the
 * split of responsibility with `apps/ingest/src/identity.int.test.ts` is deliberate:
 *
 *   - the HTTP suite validates the PRIMARY defence (route gates, guards, end-to-end flows);
 *   - THIS file validates the PREDICATES — the cross-tenant negatives and the last-owner
 *     transaction guard.
 *
 * That split is the 15.3 lesson: an endpoint-level suite passes largely on the strength of its
 * explicit `orgId` predicates, so predicate proof belongs one layer down where a missing one is
 * directly observable.
 *
 * And here there is a sharper reason than convention. `memberships` and `users` carry NO RLS at all
 * (D-15.3-4 — they are the identity tables org resolution itself reads), so unlike every other
 * repository in this package there is NO BACKSTOP behind a forgotten `eq(memberships.orgId, …)`.
 * This is the one file in the slice where a missing org predicate is a genuine cross-tenant read,
 * which is exactly why tests 2 and 8 below assert the negative directly rather than trusting a
 * policy to catch it.
 *
 * Two roles nonetheless, because `bypassed ≠ enforced` is a habit and not a case-by-case judgement:
 * the owner handle does setup only (TRUNCATE requires table ownership) and every assertion runs on
 * the non-owner handle the server actually connects as.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.5 member management (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userOwner: string;
  let userSecondOwner: string;
  let userMember: string;
  let userStranger: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    userOwner = await setUserPassword(owner.db, "owner@example.com", HASH);
    userSecondOwner = await setUserPassword(owner.db, "second@example.com", HASH);
    userMember = await setUserPassword(owner.db, "member@example.com", HASH);
    userStranger = await setUserPassword(owner.db, "stranger@example.com", HASH);

    // GOTCHA-1, restated as a seeding rule: `setUserPassword` calls `ensurePersonalOrg`, so EVERY
    // user above already holds an `owner` membership in their own personal org. The colleagues are
    // therefore MOVED into org A rather than given a SECOND membership — `findPrincipalByEmail`
    // resolves the FIRST membership by (created_at, id), so an inserted row would be shadowed by
    // the personal `owner` one and every role assertion below would silently be testing an owner.
    orgA = await ensurePersonalOrg(owner.db, userOwner, "owner@example.com");
    for (const [userId, role] of [
      [userSecondOwner, "owner"],
      [userMember, "member"],
    ] as const) {
      await owner.db
        .update(memberships)
        .set({ orgId: orgA, role })
        .where(eq(memberships.userId, userId));
    }
    // The stranger keeps their OWN org — org B, the cross-tenant control.
    orgB = await ensurePersonalOrg(owner.db, userStranger, "stranger@example.com");
    expect(orgA).not.toBe(orgB);
  });

  // 1 ── ROLE IDENTITY. Non-negotiable, and FIRST: without it the whole file is theatre. Point the
  //      "app" handle at the owner URL by mistake and every isolation test below still passes.
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

  // 2 ── THE CROSS-TENANT NEGATIVE. `memberships` has no policy, so this predicate IS the boundary.
  it("listMembers returns every member of org A and NO member of org B", async () => {
    const a = await listMembers(appRole.db, orgA);
    expect(a.map((m) => m.email).sort()).toEqual([
      "member@example.com",
      "owner@example.com",
      "second@example.com",
    ]);
    expect(a.map((m) => m.email)).not.toContain("stranger@example.com");

    // …and the reciprocal, so a predicate that accidentally matched everything cannot pass.
    const b = await listMembers(appRole.db, orgB);
    expect(b.map((m) => m.email)).toEqual(["stranger@example.com"]);
  });

  it("listMembers never puts password_hash on the wire", async () => {
    // The explicit `memberRowColumns` list is what stops this; a bare select() over users ⨝
    // memberships would leak the hash, and no route declares a response schema to strip it.
    const [first] = await listMembers(appRole.db, orgA);
    expect(Object.keys(first!).sort()).toEqual(["email", "joinedAt", "role", "userId"]);
  });

  // 3 ── THE LAST-OWNER GUARD (D-15.5-12), demotion half.
  it("setMemberRole refuses to demote the LAST owner, and the row is unchanged", async () => {
    // Reduce org A to exactly one owner.
    await owner.db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.userId, userSecondOwner));

    await expect(
      appRole.db.transaction((tx) => setMemberRole(tx, orgA, userOwner, "member")),
    ).rejects.toThrow(MemberError);

    const still = await findMemberByUserId(appRole.db, orgA, userOwner);
    expect(still!.role).toBe("owner"); // the refusal ROLLED BACK, it did not half-apply
  });

  it("the last-owner refusal carries reason 'last_owner' (so a route can map it to 409)", async () => {
    await owner.db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.userId, userSecondOwner));
    await expect(
      appRole.db.transaction((tx) => setMemberRole(tx, orgA, userOwner, "viewer")),
    ).rejects.toMatchObject({ name: "MemberError", reason: "last_owner" });
  });

  // 4 ── …AND THE OTHER HALF. Without this, a guard that refused EVERY demotion would look correct.
  it("setMemberRole demoting a NON-last owner succeeds", async () => {
    // Org A has two owners here, so demoting one is legal.
    const updated = await appRole.db.transaction((tx) =>
      setMemberRole(tx, orgA, userSecondOwner, "member"),
    );
    expect(updated.role).toBe("member");
    expect((await findMemberByUserId(appRole.db, orgA, userSecondOwner))!.role).toBe("member");
  });

  it("setMemberRole on a NON-member throws reason 'not_a_member' (never a silent no-op)", async () => {
    await expect(
      appRole.db.transaction((tx) => setMemberRole(tx, orgA, userStranger, "member")),
    ).rejects.toMatchObject({ name: "MemberError", reason: "not_a_member" });
  });

  // 5 ── THE LAST-OWNER GUARD, removal half.
  it("removeMember refuses the last owner and succeeds on an ordinary member", async () => {
    await owner.db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.userId, userSecondOwner));

    await expect(
      appRole.db.transaction((tx) => removeMember(tx, orgA, userOwner)),
    ).rejects.toMatchObject({ name: "MemberError", reason: "last_owner" });
    expect(await findMemberByUserId(appRole.db, orgA, userOwner)).toBeDefined();

    // A plain member goes, and their `users` row SURVIVES — an identity may belong to other orgs
    // (15.10), and deleting it would cascade into every row that references it.
    expect(await appRole.db.transaction((tx) => removeMember(tx, orgA, userMember))).toBe(true);
    expect(await findMemberByUserId(appRole.db, orgA, userMember)).toBeUndefined();
    const users = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from users where email = 'member@example.com'`,
    );
    expect(users.rows[0]!.n).toBe(1);
  });

  it("removeMember returns false for a NON-member rather than throwing", async () => {
    // False, not an error: the route turns it into a 404 that does not reveal whether the id exists
    // in another tenant.
    expect(await appRole.db.transaction((tx) => removeMember(tx, orgA, userStranger))).toBe(false);
  });

  // 6 ── D-15.5-3 at the repository layer.
  it("findMemberByEmail is CASE-INSENSITIVE", async () => {
    const found = await findMemberByEmail(appRole.db, orgA, "Owner@Example.COM");
    expect(found?.userId).toBe(userOwner);
    // …and surrounding whitespace is trimmed, because `normalizeEmail` does both and a pasted
    // address routinely carries a trailing space.
    expect((await findMemberByEmail(appRole.db, orgA, " owner@example.com "))?.userId).toBe(
      userOwner,
    );
  });

  // 7 ── THE D-M15-8 PROOF, at the layer the route depends on.
  it("findMemberByEmail cannot resolve another org's member", async () => {
    // An admin of org B asking for org A's owner gets NOTHING — which is what makes the pairing-code
    // route's 404 a real boundary rather than a message.
    expect(await findMemberByEmail(appRole.db, orgB, "owner@example.com")).toBeUndefined();
    expect(await findMemberByUserId(appRole.db, orgB, userOwner)).toBeUndefined();
    // …while the same lookup in the RIGHT org resolves, so the negative above is not simply a
    // broken query.
    expect(await findMemberByEmail(appRole.db, orgA, "owner@example.com")).toBeDefined();
  });
});
