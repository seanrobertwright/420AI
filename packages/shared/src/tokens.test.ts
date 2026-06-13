import { describe, it, expect } from "vitest";
import { zeroTokens, addTokens, computeTotal, type NormalizedTokens } from "./tokens.js";

describe("tokens", () => {
  it("zeroTokens is all zero", () => {
    expect(zeroTokens()).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      tool: 0,
      total: 0,
    });
  });

  it("computeTotal sums input+output+cache_read+cache_write only", () => {
    const t: NormalizedTokens = {
      input: 100,
      output: 50,
      cache_read: 30,
      cache_write: 20,
      reasoning: 999, // must NOT be counted in V1
      tool: 999, // must NOT be counted in V1
      total: 0,
    };
    expect(computeTotal(t)).toBe(200);
  });

  it("addTokens sums field-wise", () => {
    const a: NormalizedTokens = {
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write: 4,
      reasoning: 5,
      tool: 6,
      total: 10,
    };
    const b: NormalizedTokens = {
      input: 10,
      output: 20,
      cache_read: 30,
      cache_write: 40,
      reasoning: 50,
      tool: 60,
      total: 100,
    };
    expect(addTokens(a, b)).toEqual({
      input: 11,
      output: 22,
      cache_read: 33,
      cache_write: 44,
      reasoning: 55,
      tool: 66,
      total: 110,
    });
  });
});
