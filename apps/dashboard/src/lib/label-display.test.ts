import { describe, it, expect } from "vitest";
import { TASK_TYPES, OUTCOMES, FRICTIONS, LABEL_CONFIDENCE } from "@420ai/shared/outcome-labels";
import {
  TASK_TYPE_LABELS,
  OUTCOME_LABELS,
  FRICTION_LABELS,
  CONFIDENCE_LABELS,
  qualityStars,
  taskTypeLabel,
  outcomeLabel,
  frictionLabel,
  confidenceLabel,
} from "./label-display.js";

/**
 * M16 16.2 — the exhaustiveness net.
 *
 * The `Record<TaskType, string>` typing already makes a missing entry a compile error, so why the
 * loops? Because the root `tsc -b` does NOT cover `apps/dashboard` (CLAUDE.md "Frontend workspace"
 * — it needs `moduleResolution: bundler` and is deliberately out of the composite graph), so the
 * compile error only fires in the separate `typecheck:dashboard` lane. These run in `npm test`,
 * which always runs. Two nets, one of which is in the default gate.
 */
describe("label-display", () => {
  it("every member of every shared closed set has a human label", () => {
    for (const v of TASK_TYPES) {
      expect(TASK_TYPE_LABELS[v], `task type ${v}`).toBeTruthy();
    }
    for (const v of OUTCOMES) {
      expect(OUTCOME_LABELS[v], `outcome ${v}`).toBeTruthy();
    }
    for (const v of FRICTIONS) {
      expect(FRICTION_LABELS[v], `friction ${v}`).toBeTruthy();
    }
    for (const v of LABEL_CONFIDENCE) {
      expect(CONFIDENCE_LABELS[v], `confidence ${v}`).toBeTruthy();
    }
  });

  it("carries no label the shared sets do not define (no orphans)", () => {
    expect(Object.keys(TASK_TYPE_LABELS).sort()).toEqual([...TASK_TYPES].sort());
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual([...OUTCOMES].sort());
    expect(Object.keys(FRICTION_LABELS).sort()).toEqual([...FRICTIONS].sort());
    expect(Object.keys(CONFIDENCE_LABELS).sort()).toEqual([...LABEL_CONFIDENCE].sort());
  });

  it("renders model_tool with its human spelling, not the normalized value", () => {
    expect(FRICTION_LABELS.model_tool).toBe("Model / tool");
    expect(frictionLabel("model_tool")).toBe("Model / tool");
    // The un-normalized form is not a member of the set and must not resolve (shared header).
    expect(frictionLabel("model/tool")).toBe("—");
  });

  /**
   * §4.3 NEUTRAL WORDING — an acceptance criterion (M16 plan, Risk 3), so it is asserted rather
   * than left to review.
   *
   * THE RULE IS "NEVER IMPLIES **USER** FAILURE", AND THE DISTINCTION IS LOAD-BEARING. A first
   * draft of this test banned "fail" everywhere and went red on `tool_failure` → "Tool failure" —
   * which is §4.3's own value, and is neutral copy working exactly as designed: it attributes the
   * friction to the TOOL, which is the whole reason that member exists (beside `non_ai`, which
   * attributes it to neither). Banning the word outright would have pushed the copy toward a vaguer
   * label and made the data worse in the name of protecting it.
   *
   * So the check is scoped: OUTCOME copy — the field that reads as a verdict on the session — must
   * carry no evaluative language, and no set may contain a word that blames the person.
   */
  it("uses neutral wording that never implies user failure", () => {
    expect(OUTCOME_LABELS.incorrect).toBe("Incorrect result");

    // The outcome set describes what the work PRODUCED. No verdicts here at all.
    const outcomeCopy = Object.values(OUTCOME_LABELS).join(" ").toLowerCase();
    for (const banned of ["fail", "bad", "poor", "wasted", "useless"]) {
      expect(outcomeCopy, `outcome copy must not contain "${banned}"`).not.toContain(banned);
    }

    // Across every set: nothing that attributes the result to the OPERATOR.
    const allCopy = [
      ...Object.values(TASK_TYPE_LABELS),
      ...Object.values(OUTCOME_LABELS),
      ...Object.values(FRICTION_LABELS),
      ...Object.values(CONFIDENCE_LABELS),
    ]
      .join(" ")
      .toLowerCase();
    for (const banned of ["gave up", "useless", "wasted", "your ", "user error", "mistake"]) {
      expect(allCopy, `copy must not contain "${banned}"`).not.toContain(banned);
    }
    // …and the one place "failure" IS allowed is the tool, never the person.
    expect(FRICTION_LABELS.tool_failure).toBe("Tool failure");
  });

  it("qualityStars renders 1..5 and refuses to invent a rating", () => {
    expect(qualityStars(1)).toBe("★☆☆☆☆");
    expect(qualityStars(5)).toBe("★★★★★");
    expect(qualityStars(3)).toBe("★★☆☆☆".replace("★☆", "★★"));
    // NOT STATED is not ZERO. An empty row of stars would assert a judgement nobody made.
    expect(qualityStars(null)).toBe("—");
    expect(qualityStars(null)).not.toContain("☆");
    // Values from an unconstrained column fall through rather than throwing.
    expect(qualityStars(0)).toBe("—");
    expect(qualityStars(6)).toBe("—");
    expect(qualityStars(2.5)).toBe("—");
  });

  it("lookups fall through to a dash for values the closed sets do not contain", () => {
    expect(taskTypeLabel("feature")).toBe("Feature");
    expect(taskTypeLabel(null)).toBe("—");
    expect(taskTypeLabel("nonsense-from-psql")).toBe("—");
    expect(outcomeLabel("shipped")).toBe("Shipped");
    expect(outcomeLabel(null)).toBe("—");
  });

  it("a NULL confidence reads as 'Not stated', which is distinct from 'Low'", () => {
    expect(confidenceLabel(null)).toBe("Not stated");
    expect(confidenceLabel("low")).toBe("Low");
    expect(confidenceLabel(null)).not.toBe(confidenceLabel("low"));
  });
});
