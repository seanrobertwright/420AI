import { describe, it, expect } from "vitest";
import { computeCost } from "./cost.js";
import { zeroTokens, type NormalizedTokens } from "./tokens.js";

function tokens(partial: Partial<NormalizedTokens>): NormalizedTokens {
  return { ...zeroTokens(), ...partial };
}

describe("computeCost", () => {
  it("known model → estimated-model-known with non-zero usd", () => {
    const t = tokens({ input: 100, output: 50, cache_read: 30, cache_write: 20 });
    const result = computeCost("claude-opus-4-8", t);
    expect(result.confidence).toBe("estimated-model-known");
    // 100*5e-6 + 50*25e-6 + 30*0.5e-6 + 20*6.25e-6
    expect(result.usd).toBeCloseTo(0.00189, 10);
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.pricingAsOf).toBe("2026-06-13");
  });

  it("unknown model → estimated-model-unknown with usd 0", () => {
    const result = computeCost("gpt-9-ultra", tokens({ input: 1000 }));
    expect(result.confidence).toBe("estimated-model-unknown");
    expect(result.usd).toBe(0);
  });

  it("no model → unknown with usd 0", () => {
    const result = computeCost(undefined, tokens({ input: 1000 }));
    expect(result.confidence).toBe("unknown");
    expect(result.usd).toBe(0);
  });
});
