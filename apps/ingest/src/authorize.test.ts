import { describe, expect, it } from "vitest";
import type { Principal } from "@420ai/db";
import { ROLES, SERVICE_ROLE, type Role } from "@420ai/shared";
import { authorized } from "./auth.js";

/**
 * M15 15.4 — the route-layer gate, in isolation. `packages/shared/src/roles.test.ts` proves the
 * ladder itself; this file proves the ROUTE adapter reads `principal.role` and nothing else, and
 * that a malformed role fails CLOSED.
 *
 * The behavioural proof that the gate is actually WIRED at each of the 45 handlers lives in
 * `rbac.int.test.ts` (per-role HTTP), with `routes/org-scoping.test.ts` as the structural
 * tripwire beside it. Neither can be replaced by this file.
 */

const principal = (role: string): Principal => ({
  userId: "11111111-1111-4111-8111-111111111111",
  email: "someone@example.com",
  orgId: "22222222-2222-4222-8222-222222222222",
  role,
});

describe("authorized", () => {
  it("permits a role at or above the minimum, and refuses one below it", () => {
    for (const [actualIndex, role] of ROLES.entries()) {
      for (const [minIndex, minimum] of ROLES.entries()) {
        expect({ role, minimum, ok: authorized(principal(role), minimum) }).toEqual({
          role,
          minimum,
          ok: actualIndex >= minIndex,
        });
      }
    }
  });

  it("refuses the SERVICE sentinel at every rung", () => {
    // SERVICE_ROLE names a machine path to `withOrg`/RLS. It is deliberately not a membership
    // rung, so it can never be mistaken for an authorization decision at a route.
    for (const minimum of ROLES) {
      expect(authorized(principal(SERVICE_ROLE), minimum)).toBe(false);
    }
  });

  it("fails CLOSED on a hand-edited role — and note the asymmetry with the RLS backstop", () => {
    // `memberships.role` is TEXT with no CHECK constraint, so 'superadmin' is storable. The
    // ROUTE layer is the strict one: an unrecognised role grants NOTHING here.
    //
    // The RLS backstop (migration 0016) behaves DIFFERENTLY on purpose — it only ever asks
    // "is the context 'viewer'?", so the same 'superadmin' row is PERMITTED to write at the
    // database layer. That is not an oversight: the backstop must default permissive or every
    // machine-authed collector write would 500. The route gate is what makes it strict.
    for (const bad of ["superadmin", "root", "Admin", "", "  "]) {
      expect(authorized(principal(bad), "viewer")).toBe(false);
    }
  });

  it("reads ONLY principal.role — the other principal fields cannot influence the decision", () => {
    const minimum: Role = "admin";
    const a = { ...principal("viewer"), email: "admin@example.com" };
    const b = { ...principal("admin"), email: "nobody@example.com" };
    expect(authorized(a, minimum)).toBe(false);
    expect(authorized(b, minimum)).toBe(true);
  });
});
