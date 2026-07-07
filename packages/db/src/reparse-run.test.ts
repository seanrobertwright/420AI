import { describe, it, expect, vi } from "vitest";
import { runReparse } from "./reparse-run.js";
import type { ReparseResult } from "./repositories/reparse.js";

function result(over: Partial<ReparseResult> = {}): ReparseResult {
  return {
    sessions: 3,
    eventsUpserted: 42,
    orphansDeleted: 2,
    skipped: { gemini: 0, other: 0 },
    ...over,
  };
}

describe("runReparse (mirrors runReprice's clean-outcome shape)", () => {
  it("runs WITHOUT an active catalog — no refusal, exit 0, no reprice note", async () => {
    const reparse = vi.fn(async () => result());
    const outcome = await runReparse({ getActive: async () => null, reparse });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toBe(
      "re-parsed 3 sessions: 42 events upserted, 2 orphaned events deleted",
    );
    // No active catalog → reparse called with undefined (built-in pricing applies).
    expect(reparse).toHaveBeenCalledWith(undefined);
  });

  it("passes the active catalog through and notes the re-pricing", async () => {
    const active = { version: "cat-2026-07", rates: {} };
    const reparse = vi.fn(async () => result());
    const outcome = await runReparse({ getActive: async () => active, reparse });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toContain("re-priced under the active catalog");
    expect(reparse).toHaveBeenCalledWith(active);
  });

  it("reports skipped gemini/other sessions honestly (label honestly, D-M13-2)", async () => {
    const outcome = await runReparse({
      getActive: async () => undefined,
      reparse: async () => result({ skipped: { gemini: 5, other: 1 } }),
    });
    expect(outcome.message).toContain("skipped 5 gemini + 1 other sessions");
  });
});
