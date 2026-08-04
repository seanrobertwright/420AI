import { describe, it, expect } from "vitest";
import {
  TASK_TYPES,
  OUTCOMES,
  FRICTIONS,
  LABEL_CONFIDENCE,
  LABEL_STATUSES,
  INTENT_MAX_LENGTH,
  FOLLOW_UP_MAX_LENGTH,
  isTaskType,
  isLabelOutcome,
  isFriction,
  isLabelConfidence,
  isLabelStatus,
  isQualityRating,
} from "./outcome-labels.js";

/**
 * M16 16.1 — these sets ARE the research plan's §4.3 specification, so this file's real job is not
 * to test five one-line `includes` calls: it is to stop a value drifting away from the document it
 * implements. Hence the exact-membership assertions below rather than only length checks — a
 * length check passes when someone renames a member.
 */
describe("outcome-label closed sets match research plan §4.3", () => {
  it("TASK_TYPES is exactly the eight §4.3 values, in order", () => {
    expect([...TASK_TYPES]).toEqual([
      "feature",
      "bug_fix",
      "investigation",
      "refactor",
      "test",
      "documentation",
      "incident",
      "other",
    ]);
  });

  it("OUTCOMES is exactly the five §4.3 values, in order", () => {
    expect([...OUTCOMES]).toEqual([
      "shipped",
      "useful_partial",
      "blocked",
      "abandoned",
      "incorrect",
    ]);
  });

  it("FRICTIONS is exactly the seven §4.3 values, with model/tool NORMALIZED to model_tool", () => {
    expect([...FRICTIONS]).toEqual([
      "none",
      "context",
      "model_tool",
      "tool_failure",
      "unclear_task",
      "verification",
      "non_ai",
    ]);
    // The normalization is the module's ONE deviation from §4.3, so it is asserted from both
    // sides: the normalized spelling is in, and the document's spelling is out.
    expect(FRICTIONS as readonly string[]).not.toContain("model/tool");
  });

  it("LABEL_CONFIDENCE is low|medium|high and LABEL_STATUSES is labeled|skipped", () => {
    expect([...LABEL_CONFIDENCE]).toEqual(["low", "medium", "high"]);
    expect([...LABEL_STATUSES]).toEqual(["labeled", "skipped"]);
  });

  it("INTENT_MAX_LENGTH is §4.3's 200, and the follow-up bound is this repo's 500", () => {
    expect(INTENT_MAX_LENGTH).toBe(200);
    expect(FOLLOW_UP_MAX_LENGTH).toBe(500);
  });
});

describe("narrowing guards accept every member and reject near-misses", () => {
  it("isTaskType", () => {
    for (const v of TASK_TYPES) expect(isTaskType(v)).toBe(true);
    // A plausible mis-spelling, a case variant, and the empty string.
    expect(isTaskType("bugfix")).toBe(false);
    expect(isTaskType("Feature")).toBe(false);
    expect(isTaskType("")).toBe(false);
  });

  it("isLabelOutcome", () => {
    for (const v of OUTCOMES) expect(isLabelOutcome(v)).toBe(true);
    expect(isLabelOutcome("partial")).toBe(false);
    expect(isLabelOutcome("Shipped")).toBe(false);
  });

  it("isFriction rejects the un-normalized §4.3 spelling", () => {
    for (const v of FRICTIONS) expect(isFriction(v)).toBe(true);
    // THE point of this assertion: `model/tool` must not enter the archive by a side door, or
    // 16.4's friction histogram would carry two bars meaning the same thing.
    expect(isFriction("model/tool")).toBe(false);
    expect(isFriction("model tool")).toBe(false);
  });

  it("isLabelConfidence and isLabelStatus", () => {
    for (const v of LABEL_CONFIDENCE) expect(isLabelConfidence(v)).toBe(true);
    for (const v of LABEL_STATUSES) expect(isLabelStatus(v)).toBe(true);
    expect(isLabelConfidence("none")).toBe(false);
    expect(isLabelStatus("skip")).toBe(false);
    expect(isLabelStatus("LABELED")).toBe(false);
  });

  it("a guard fails CLOSED on a prototype key (the roles.ts Object.hasOwn lesson)", () => {
    // `includes` over an array has no prototype-chain hazard the way an object-literal lookup
    // does — asserted here so the difference from `hasRole` is a measured fact rather than an
    // assumption, since these guards are the only enforcement behind a CHECK-less TEXT column.
    expect(isTaskType("constructor")).toBe(false);
    expect(isLabelStatus("__proto__")).toBe(false);
  });
});

describe("isQualityRating bounds §4.3's 1–5", () => {
  it("accepts 1 through 5", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isQualityRating(n)).toBe(true);
  });

  it("rejects the off-by-one boundaries, non-integers and non-finite values", () => {
    for (const n of [0, 6, -1, 2.5, NaN, Infinity]) expect(isQualityRating(n)).toBe(false);
  });
});
