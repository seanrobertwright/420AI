import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, isAuditAction } from "./audit.js";

describe("AUDIT_ACTIONS", () => {
  it("is non-empty", () => {
    // A vacuous scan is the worst kind of green: every assertion below iterates the set, so an
    // empty set would make all of them pass while checking nothing.
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(0);
  });

  it("has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("is sorted", () => {
    // Sorted so a reviewer can see at a glance whether an action is present, and so a diff that
    // adds one lands next to its siblings rather than at the end of a growing pile.
    expect([...AUDIT_ACTIONS]).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("every entry is <subject>.<verb_past_tense> in snake_case", () => {
    // The contract with the `action` TEXT column, which has no CHECK. A stray capital or a hyphen
    // would make a break-glass `where action like 'member.%'` quietly miss rows.
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("isAuditAction accepts every member and rejects a near miss", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(isAuditAction(action)).toBe(true);
    }
    expect(isAuditAction("member.removed ")).toBe(false);
    expect(isAuditAction("member.deleted")).toBe(false);
    expect(isAuditAction("")).toBe(false);
    // The prototype-chain hazard `hasRole` had to fix: `includes` on an array has no such hole,
    // but pinning it stops a future rewrite to an object lookup from reintroducing one.
    expect(isAuditAction("toString")).toBe(false);
    expect(isAuditAction("constructor")).toBe(false);
  });
});
