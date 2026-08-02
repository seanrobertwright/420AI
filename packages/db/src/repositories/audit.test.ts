import { describe, expect, it } from "vitest";
import * as auditRepo from "./audit.js";

/**
 * M15 15.10 — the D-15.10-4 WRITE-ONLY guard, asserted structurally.
 *
 * This is a CHEAP FIRST NET, in the same register as `routes/org-scoping.test.ts`: it reads export
 * NAMES, so it cannot tell a reader from a writer by behaviour, and a determined reader called
 * `fetchTheRows` would slip past it. `audit.int.test.ts` is the behavioural proof — it drives a real
 * non-owner handle and asserts a raw SELECT returns zero rows. What THIS test buys is that the
 * decision is visible at the moment somebody types `export async function listAuditEvents`, in the
 * file they are editing, rather than three layers away in a policy they have not read.
 *
 * The decision it pins: the app role reads ZERO rows from `audit_events` (no SELECT policy —
 * migration 0023), so a reader added here would compile, run, and return an empty array FOREVER,
 * with no error to notice. Adding one is therefore a two-part change — reader plus a strict SELECT
 * policy, in the same commit — and this test is what makes the second half unskippable.
 */
describe("audit repository is write-only (D-15.10-4)", () => {
  const exportNames = Object.keys(auditRepo);

  it("has exports at all (guards against the namespace import silently resolving to {})", () => {
    // A structural test that scans nothing passes vacuously — the worst kind of green.
    expect(exportNames.length).toBeGreaterThan(0);
  });

  it("exports exactly the one writer", () => {
    expect(exportNames.sort()).toEqual(["recordAuditEvent"]);
  });

  it("exports no reader", () => {
    const readers = exportNames.filter((name) =>
      /^(list|find|get|select|count|search)/i.test(name),
    );
    expect(
      readers,
      "audit_events has NO SELECT policy for the app role, so any reader added here returns an " +
        "empty list forever with no error. If a read path is genuinely wanted, add a strict SELECT " +
        "policy in the SAME commit (and the role gating that goes with it) — D-15.10-4.",
    ).toEqual([]);
  });
});
