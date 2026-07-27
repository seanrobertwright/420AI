import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, withOrg } from "../index.js";
import { users } from "../schema.js";
import { ensurePersonalOrg } from "./organizations.js";
import { createProject } from "./projects.js";
import {
  effectiveProjectRole,
  grantProjectRole,
  listProjectGrants,
  revokeProjectGrant,
} from "./project-grants.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

/**
 * M15 15.4 — the per-project grant repository, as a TWO-ROLE suite.
 *
 * Two roles rather than one because `project_grants` carries a STRICT org policy (migration
 * 0016) and an owner-connected suite would bypass it entirely: `bypassed ≠ enforced`, the
 * sibling of `skipped ≠ passed`. The owner handle does setup only (TRUNCATE requires
 * ownership); every assertion runs on the non-owner `420ai_app` handle.
 *
 * What this file pins that a type cannot:
 *   1. grants ELEVATE and never DEMOTE — the whole D-15.4-2 direction;
 *   2. re-granting is an UPDATE, not a duplicate row (the unique index is load-bearing);
 *   3. another org's grants are invisible under the app role.
 */

const WRITE_ROLE = "member";

describe.skipIf(!TEST_URL || !APP_URL)("M15 15.4 project grants (two-role integration)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let projectA: string;
  let projectB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE project_grants, projects, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const seeded = await owner.db
      .insert(users)
      .values([{ email: "a@example.com" }, { email: "b@example.com" }])
      .returning({ id: users.id, email: users.email });
    userA = seeded.find((u) => u.email === "a@example.com")!.id;
    userB = seeded.find((u) => u.email === "b@example.com")!.id;
    orgA = await ensurePersonalOrg(owner.db, userA, "a@example.com");
    orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    projectA = (await createProject(owner.db, orgA, userA, "project-a")).id;
    projectB = (await createProject(owner.db, orgB, userB, "project-b")).id;
  });

  // 1 ── ROLE IDENTITY. Without this every assertion below is theatre: point the "app" handle
  //      at the owner URL by mistake and the isolation test still passes.
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

  it("grantProjectRole is idempotent — a re-grant UPDATES the role, never duplicates the row", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      const first = await grantProjectRole(tx, orgA, projectA, userB, "member");
      expect(first.role).toBe("member");
      const second = await grantProjectRole(tx, orgA, projectA, userB, "admin");
      expect(second.role).toBe("admin");
      // The unique index on (project_id, user_id) is what makes the second call an UPDATE.
      expect(second.id).toBe(first.id);
      expect(await listProjectGrants(tx, orgA, projectA)).toHaveLength(1);
    });
  });

  it("a grant ELEVATES the org role but NEVER demotes it (D-15.4-2)", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      // No grant at all ⇒ the org role, unchanged. This is why a solo install is byte-identical
      // to pre-15.4: the table is empty and every answer is the membership role.
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "viewer")).toBe("viewer");

      // A HIGHER grant elevates…
      await grantProjectRole(tx, orgA, projectA, userB, "admin");
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "viewer")).toBe("admin");

      // …and a LOWER grant is a NO-OP, not a demotion. This is the direction the whole design
      // rests on: because a grant can only ADD capability, no read path anywhere has to consult
      // this table in order to be SAFE — only in order to be generous.
      await grantProjectRole(tx, orgA, projectA, userB, "viewer");
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "admin")).toBe("admin");
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "owner")).toBe("owner");
    });
  });

  it("an equal grant is a no-op, and an unknown org role degrades to itself", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      await grantProjectRole(tx, orgA, projectA, userB, "member");
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "member")).toBe("member");
      // A hand-edited `memberships.role` makes `hasRole` fail closed, so no grant can elevate
      // it — the corrupt row degrades to itself rather than being silently promoted.
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "superadmin")).toBe(
        "superadmin",
      );
    });
  });

  it("revokeProjectGrant removes the row and reports whether it did", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      await grantProjectRole(tx, orgA, projectA, userB, "admin");
      expect(await revokeProjectGrant(tx, orgA, projectA, userB)).toBe(true);
      expect(await listProjectGrants(tx, orgA, projectA)).toEqual([]);
      // A second revoke removed nothing — the caller can tell the difference.
      expect(await revokeProjectGrant(tx, orgA, projectA, userB)).toBe(false);
      // …and capability falls back to the org role.
      expect(await effectiveProjectRole(tx, orgA, projectA, userB, "viewer")).toBe("viewer");
    });
  });

  it("another org's grants are INVISIBLE under the app role", async () => {
    await withOrg(appRole.db, orgB, WRITE_ROLE, (tx) =>
      grantProjectRole(tx, orgB, projectB, userB, "owner"),
    );
    // Org A cannot see it — neither by listing org B's project nor through the resolver, which
    // therefore answers with org A's own membership role. Both the explicit `orgId` predicate
    // (the PRIMARY defence) and the strict policy (the BACKSTOP) point the same way here.
    await withOrg(appRole.db, orgA, WRITE_ROLE, async (tx) => {
      expect(await listProjectGrants(tx, orgA, projectB)).toEqual([]);
      expect(await effectiveProjectRole(tx, orgA, projectB, userB, "viewer")).toBe("viewer");
    });
    // Org B still sees its own.
    await withOrg(appRole.db, orgB, WRITE_ROLE, async (tx) => {
      expect(await listProjectGrants(tx, orgB, projectB)).toHaveLength(1);
      expect(await effectiveProjectRole(tx, orgB, projectB, userB, "viewer")).toBe("owner");
    });
  });

  it("with NO org context a grant read returns zero rows, silently (the strict policy)", async () => {
    await withOrg(appRole.db, orgA, WRITE_ROLE, (tx) =>
      grantProjectRole(tx, orgA, projectA, userB, "admin"),
    );
    // Unwrapped: 0 rows, NOT an error. That is the failure mode the repo header warns about —
    // an unwrapped call reports "no grant", which degrades to the org role: safe, but invisible.
    const bare = await appRole.db.execute<{ n: number }>(
      sql`select count(*)::int as n from project_grants`,
    );
    expect(bare.rows[0]!.n).toBe(0);
  });
});
