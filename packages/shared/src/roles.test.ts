import { describe, expect, it } from "vitest";
import { hasRole, isRole, ROLES, SERVICE_ROLE, type Role } from "./roles.js";

/**
 * M15 15.4 — the role ladder, exhaustively. Pure, no infra.
 *
 * The whole point of an ORDERED ladder is that "admin or better" is a rank comparison,
 * so the table below covers all 4x4 (role, minimum) pairs rather than spot-checking.
 */

describe("ROLES", () => {
  it("is ordered least- to most-privileged", () => {
    expect([...ROLES]).toEqual(["viewer", "member", "admin", "owner"]);
  });

  it("has no duplicates", () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe("hasRole", () => {
  it("every rung satisfies itself", () => {
    for (const role of ROLES) {
      expect(hasRole(role, role)).toBe(true);
    }
  });

  it("every rung satisfies everything below it and nothing above it", () => {
    for (const [actualIndex, role] of ROLES.entries()) {
      for (const [minimumIndex, minimum] of ROLES.entries()) {
        expect({ role, minimum, allowed: hasRole(role, minimum) }).toEqual({
          role,
          minimum,
          allowed: actualIndex >= minimumIndex,
        });
      }
    }
  });

  it("SERVICE_ROLE satisfies NOTHING — it is not an authorization decision", () => {
    // The sentinel exists so machine paths can name themselves to `withOrg`/RLS. It is
    // deliberately outside `Role`, so it can never be mistaken for a membership rung.
    for (const minimum of ROLES) {
      expect(hasRole(SERVICE_ROLE, minimum)).toBe(false);
    }
  });

  it("fails CLOSED on unknown, empty and wrongly-cased inputs", () => {
    // `memberships.role` is TEXT with no CHECK constraint, so a hand-edited row can hold
    // anything. Note the asymmetry pinned in rbac.int.test.ts: the ROUTE layer is strict
    // (an unknown role grants nothing), while the RLS backstop only asks "is this a
    // viewer?" and therefore permits an unknown role to write.
    for (const bad of ["", " ", "Admin", "OWNER", "root", "superadmin", "service "]) {
      for (const minimum of ROLES) {
        expect({ bad, minimum, allowed: hasRole(bad, minimum) }).toEqual({
          bad,
          minimum,
          allowed: false,
        });
      }
    }
  });

  it("does not treat INHERITED object keys as roles", () => {
    // `RANK` is an object literal, so it inherits from Object.prototype: `RANK["toString"]` is a
    // FUNCTION, not undefined. A `!== undefined` guard passes for every key below and the answer
    // comes out false only via `fn >= 0` → `NaN >= 0`. `hasRole` uses `Object.hasOwn` so these
    // are rejected by the guard itself — which is what makes this test meaningful rather than
    // merely green.
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(hasRole(key, "viewer")).toBe(false);
      expect(isRole(key)).toBe(false);
    }
  });
});

describe("isRole", () => {
  it("accepts exactly the four rungs", () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
  });

  it("rejects the service sentinel and anything else", () => {
    for (const bad of [SERVICE_ROLE, "", "Admin", "root"]) {
      expect(isRole(bad)).toBe(false);
    }
  });

  it("narrows to Role", () => {
    const value: string = "admin";
    if (isRole(value)) {
      const narrowed: Role = value;
      expect(narrowed).toBe("admin");
    } else {
      expect.unreachable("admin must narrow");
    }
  });
});
