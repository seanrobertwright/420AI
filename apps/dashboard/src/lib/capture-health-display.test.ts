import { describe, expect, it } from "vitest";
import { CAPTURE_HEALTH_VERDICT } from "@420ai/shared/capture-health";
import type { CaptureHealthState } from "@420ai/shared/capture-health";
import {
  STATE_DESCRIPTIONS,
  STATE_LABELS,
  STATE_TONE,
  TONE_BADGE_CLASS,
  VERDICT_LABELS,
  badgeClassForState,
} from "./capture-health-display";

/**
 * The state list is derived from `CAPTURE_HEALTH_VERDICT`'s keys rather than hand-written, so a
 * state added in `@420ai/shared` appears here automatically and the exhaustiveness checks below
 * cannot silently stop covering it.
 */
const ALL_STATES = Object.keys(CAPTURE_HEALTH_VERDICT) as CaptureHealthState[];

describe("capture health display maps", () => {
  it("covers every state in the shared union", () => {
    expect(ALL_STATES.length).toBeGreaterThan(0);
    for (const s of ALL_STATES) {
      expect(STATE_LABELS[s], `no label for ${s}`).toBeTruthy();
      expect(STATE_DESCRIPTIONS[s], `no description for ${s}`).toBeTruthy();
      expect(STATE_TONE[s], `no tone for ${s}`).toBeTruthy();
      expect(badgeClassForState(s)).toBe(TONE_BADGE_CLASS[STATE_TONE[s]]);
    }
  });

  it("has no extra keys beyond the shared union", () => {
    expect(Object.keys(STATE_LABELS).sort()).toEqual([...ALL_STATES].sort());
    expect(Object.keys(STATE_TONE).sort()).toEqual([...ALL_STATES].sort());
  });

  /**
   * THE RISK 2 ASSERTION. A scorecard that renders "I don't know" as green converts an outage into
   * evidence; rendering it as red trains the operator to ignore the panel. Both are failures, so
   * the two unknown states must be neither.
   */
  it("styles `unreported` and `unknown` as NEITHER success nor failure", () => {
    for (const s of ["unreported", "unknown"] as const) {
      expect(CAPTURE_HEALTH_VERDICT[s]).toBe("unknown");
      expect(STATE_TONE[s]).not.toBe("success");
      expect(STATE_TONE[s]).not.toBe("failure");
    }
  });

  it("only `healthy` reads as success", () => {
    const success = ALL_STATES.filter((s) => STATE_TONE[s] === "success");
    expect(success).toEqual(["healthy"]);
  });

  it("wording stays neutral: idle is not phrased as a failure", () => {
    expect(STATE_DESCRIPTIONS.idle.toLowerCase()).toContain("no recent activity");
    // It may MENTION breakage, but only to rule it out — "nothing suggests capture is broken" is a
    // reassurance, which is the whole point. What it must never do is assert a failure or blame the
    // absence of work ("nothing captured"), so assert the reassuring form directly rather than
    // banning the word.
    expect(STATE_DESCRIPTIONS.idle.toLowerCase()).toContain("nothing suggests capture is broken");
    expect(STATE_DESCRIPTIONS.idle.toLowerCase()).not.toContain("nothing captured");
    // `unreported` tells the operator what to DO, rather than implying an error.
    expect(STATE_DESCRIPTIONS.unreported.toLowerCase()).toContain("upgrade");
    expect(STATE_DESCRIPTIONS.unreported.toLowerCase()).not.toContain("error");
  });

  it("`silent` is worded as suspicion, not as a verdict", () => {
    expect(STATE_DESCRIPTIONS.silent.toLowerCase()).toContain("worth checking");
  });

  it("labels every verdict the shared map can produce", () => {
    for (const s of ALL_STATES) {
      expect(VERDICT_LABELS[CAPTURE_HEALTH_VERDICT[s]], `no verdict label for ${s}`).toBeTruthy();
    }
  });
});
