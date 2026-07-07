import { describe, it, expect, vi } from "vitest";
import { runReprice } from "./reprice-run.js";

/**
 * F.5 regression: with no active catalog, `npm run db:reprice` printed a raw Node stack trace (the
 * CLI did `throw new Error("no active catalog…")`). The UAT expects a CLEAN refusal (409-style), not
 * a crash. runReprice returns a friendly message + non-zero exit and NEVER throws for that case.
 */
describe("runReprice (F.5 — clean refusal, not a crash)", () => {
  it("refuses cleanly when there is no active catalog (null) — no throw, exit 1", async () => {
    const reprice = vi.fn();
    const outcome = await runReprice({ getActive: async () => null, reprice });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("No active pricing catalog");
    expect(reprice).not.toHaveBeenCalled(); // refused before touching data
  });

  it("treats undefined the same as null (clean refusal)", async () => {
    const outcome = await runReprice({ getActive: async () => undefined, reprice: vi.fn() });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("approve one first");
  });

  it("re-prices and reports counts when a catalog is active (exit 0)", async () => {
    const active = { version: "cat-2026-06", rates: {} };
    const reprice = vi.fn(async () => ({ repriced: 7, catalogVersion: active.version }));
    const outcome = await runReprice({ getActive: async () => active, reprice });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toBe("re-priced 7 events under catalog cat-2026-06");
    expect(reprice).toHaveBeenCalledWith(active);
  });
});
