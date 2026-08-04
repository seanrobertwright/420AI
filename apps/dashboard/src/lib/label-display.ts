import {
  TASK_TYPES,
  OUTCOMES,
  FRICTIONS,
  LABEL_CONFIDENCE,
  type TaskType,
  type LabelOutcome,
  type Friction,
  type LabelConfidence,
} from "@420ai/shared/outcome-labels";

/**
 * M16 16.2 — the human-readable rendering of the §4.3 closed value sets. PURE, so it is unit-tested
 * (the dashboard has no component-test lane; only `src/lib/*.test.ts` runs, which is why every
 * decidable piece of this slice's display logic lives here rather than inside a `.tsx`).
 *
 * IMPORTED FROM THE `/outcome-labels` SUBPATH, NEVER THE PACKAGE ROOT — the same rule
 * `team-view.tsx` states for `/roles`. The root barrel re-exports `catalog-signing` and eight
 * parsers, and these maps are consumed by "use client" islands, so a root import would drag all of
 * that into the browser bundle. `outcome-labels.ts` has no imports at all.
 *
 * THE MAPS ARE TYPED `Record<TaskType, string>`, NOT `Record<string, string>`, AND THAT IS THE
 * POINT. Adding a member to a shared array is a research decision-log entry (§11), and the failure
 * mode of forgetting this file would otherwise be a BLANK CELL in the review table — a UI that
 * silently renders nothing for a value the archive holds. With the exact key type it is a compile
 * error in `typecheck:dashboard` instead. The test loops the arrays as a second net, because the
 * root `tsc -b` does not cover this workspace (CLAUDE.md "Frontend workspace").
 *
 * NEUTRAL WORDING IS AN ACCEPTANCE CRITERION, NOT A STYLE PREFERENCE (§4.3, M16 plan Risk 3). The
 * research period depends on an operator volunteering an honest judgement in 15 seconds; copy that
 * reads as a verdict on them suppresses exactly the negative labels the data most needs. So:
 * `incorrect` is "Incorrect result" and never "Failure"; `abandoned` is "Abandoned" and never
 * "Gave up"; `quality_rating` is labelled "Usefulness" and never "Score"; and a 1 carries no more
 * visual weight than a 5.
 */

/** §4.3 `task_type`. */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: "Feature",
  bug_fix: "Bug fix",
  investigation: "Investigation",
  refactor: "Refactor",
  test: "Test",
  documentation: "Documentation",
  incident: "Incident",
  other: "Other",
};

/** §4.3 `outcome` — what the work PRODUCED. Descriptive, never evaluative of the person. */
export const OUTCOME_LABELS: Record<LabelOutcome, string> = {
  shipped: "Shipped",
  useful_partial: "Useful but partial",
  blocked: "Blocked",
  abandoned: "Abandoned",
  // "Incorrect result", not "Failure": the statement is about the OUTPUT, not the operator.
  incorrect: "Incorrect result",
};

/** §4.3 `primary_friction` — what got in the way. */
export const FRICTION_LABELS: Record<Friction, string> = {
  none: "None",
  context: "Context",
  // `model_tool` is §4.3's `model/tool`, normalized in the shared module because `/` is not legal
  // in a URL path segment. Render the human spelling; do NOT "fix" the stored value.
  model_tool: "Model / tool",
  tool_failure: "Tool failure",
  unclear_task: "Unclear task",
  verification: "Verification",
  // Friction that had nothing to do with the assistant — what stops every unproductive session
  // being attributed to the product by default.
  non_ai: "Not AI-related",
};

/** §7 P0.2 "optional confidence". NULL ("not stated") is deliberately NOT a member. */
export const CONFIDENCE_LABELS: Record<LabelConfidence, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Render `quality_rating` (1–5) as filled/empty marks.
 *
 * NULL RENDERS AS "—", NOT AS FIVE EMPTY STARS. "Not stated" and "rated 0" are different claims and
 * a skipped label carries the former; drawing an empty row of stars would assert the latter, which
 * is a judgement no human made — the thing §5.3 and D-16.1-8 exist to prevent. An out-of-range
 * value falls through to the same "—" rather than throwing, because this renders values read back
 * out of a TEXT/INTEGER column with no CHECK constraint, including any written by a break-glass
 * `psql` session (D-M15-7).
 */
export function qualityStars(n: number | null): string {
  if (n === null || !Number.isInteger(n) || n < 1 || n > 5) return "—";
  return "★".repeat(n) + "☆".repeat(5 - n);
}

/** Look up a display label for a value read out of an unconstrained TEXT column. */
export function taskTypeLabel(v: string | null): string {
  return v && (TASK_TYPES as readonly string[]).includes(v) ? TASK_TYPE_LABELS[v as TaskType] : "—";
}

/** Look up a display label for a value read out of an unconstrained TEXT column. */
export function outcomeLabel(v: string | null): string {
  return v && (OUTCOMES as readonly string[]).includes(v) ? OUTCOME_LABELS[v as LabelOutcome] : "—";
}

/** Look up a display label for a value read out of an unconstrained TEXT column. */
export function frictionLabel(v: string | null): string {
  return v && (FRICTIONS as readonly string[]).includes(v) ? FRICTION_LABELS[v as Friction] : "—";
}

/** Look up a display label. NULL is "Not stated", which is distinct from `low` (D-16.1-8). */
export function confidenceLabel(v: string | null): string {
  if (!v) return "Not stated";
  return (LABEL_CONFIDENCE as readonly string[]).includes(v)
    ? CONFIDENCE_LABELS[v as LabelConfidence]
    : "—";
}
