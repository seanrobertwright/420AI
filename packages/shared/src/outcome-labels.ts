/**
 * M16 16.1 — the closed value sets of the §4.3 OUTCOME LABEL (research plan §4.3, §7 P0.2).
 *
 * A label is the one thing in this archive a HUMAN volunteers: automatic capture answers what
 * happened (tokens, cost, tool calls, commits) and cannot answer whether the work was useful.
 * These sets are the specification for that answer.
 *
 * TEXT, not a pg enum, matching `memberships.role` (schema.ts:87), `ROLES` and every other closed
 * set in this repo — adding a value is a code change, not a migration. The `outcome_labels` columns
 * carry NO CHECK constraint, so THESE GUARDS PLUS THE ROUTE'S JSON-SCHEMA ENUMS ARE THE
 * ENFORCEMENT. The route builds its enums from these arrays (`[...TASK_TYPES]`) rather than
 * re-typing the strings, so a value added here cannot be silently rejected at the HTTP edge.
 *
 * THE VALUES ARE THE RESEARCH PLAN'S, NOT THIS MODULE'S. `.agents/supplemental docs/
 * research-analysis-plan.md` §4.3 owns WHAT is measured; this repo owns HOW it is built. Changing,
 * adding or removing a member below is therefore a research decision-log entry (§11) rather than a
 * refactor — every label recorded under the old set stays in the table with its old value, and
 * 16.4's data-quality audit reads them as one series.
 *
 * ONE DEVIATION, and it is a spelling change rather than a semantic one. §4.3 writes the third
 * friction as `model/tool`; a `/` is not legal in a URL path segment, is ambiguous in a CSV header,
 * and forces quoting at every TypeScript use site. It is normalized to `model_tool` here — the
 * only place the two spellings differ, and `isFriction("model/tool")` deliberately returns FALSE
 * so the un-normalized form cannot enter the archive by a side door (asserted in the unit test).
 *
 * PRIVACY, stated because §4.3 makes it a rule rather than a nicety: labels are private to the
 * user's own archive. They are org-scoped tenant rows behind the M15 15.3 RLS backstop, and the
 * export path redacts them (D-16.1-7) because `intent` is free human text.
 */

/** §4.3 `task_type` — what KIND of work the session was. Enables meaningful comparisons. */
export const TASK_TYPES = [
  "feature",
  "bug_fix",
  "investigation",
  "refactor",
  "test",
  "documentation",
  "incident",
  "other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * §4.3 `outcome` — what the work actually PRODUCED. Separates activity from result, which is the
 * distinction the whole research period exists to measure: a session can burn 200k tokens and
 * ship nothing.
 */
export const OUTCOMES = ["shipped", "useful_partial", "blocked", "abandoned", "incorrect"] as const;
export type LabelOutcome = (typeof OUTCOMES)[number];

/**
 * §4.3 `primary_friction` — what got in the way. Makes failure modes actionable.
 *
 * `model_tool` is §4.3's `model/tool`, normalized — see the header. `non_ai` covers friction that
 * had nothing to do with the assistant (a flaky CI, a meeting), which is what stops every
 * unproductive session being attributed to the product by default.
 */
export const FRICTIONS = [
  "none",
  "context",
  "model_tool",
  "tool_failure",
  "unclear_task",
  "verification",
  "non_ai",
] as const;
export type Friction = (typeof FRICTIONS)[number];

/**
 * §7 P0.2 "optional confidence". NULL in the database means NOT STATED — deliberately distinct
 * from `low`, which is a human saying "I am unsure". §5.3 forbids inferring a human outcome
 * without marking confidence; there is no inference path in this API at all (D-16.1-8), so this
 * field only ever carries a value a person chose.
 */
export const LABEL_CONFIDENCE = ["low", "medium", "high"] as const;
export type LabelConfidence = (typeof LABEL_CONFIDENCE)[number];

/**
 * D-16.1-2 — A SKIP IS A ROW.
 *
 * §4.3 requires "offer skip and do not nag repeatedly", and the second half is unimplementable
 * without persisting the first: with no `skipped` row the tray has no way to know it already
 * asked, so it asks again on every session view — the exact behaviour §12 names as the thing that
 * kills label completion.
 *
 * A `skipped` row carries NONE of the six §4.3 fields. 16.4's completion metric is therefore
 * `count(status='labeled') / count(*)`, which correctly puts a skipped session in the denominator
 * of "sessions I was asked about" and out of the numerator of "sessions I judged".
 */
export const LABEL_STATUSES = ["labeled", "skipped"] as const;
export type LabelStatus = (typeof LABEL_STATUSES)[number];

/** §4.3 "Short free text, max 200 characters". Enforced at the HTTP edge, not by the column. */
export const INTENT_MAX_LENGTH = 200;

/**
 * A Git SHA, PR URL or issue id. §4.3 marks it OPTIONAL; the bound is this repo's own habit of
 * bounding every free-text field at the edge (`schemas.ts`), not a research-plan number.
 */
export const FOLLOW_UP_MAX_LENGTH = 500;

/**
 * The six §4.3 fields as one shape, for the three consumers that all need them: this slice's
 * repository input, 16.2's tray/dashboard form, and 16.4's audit report. Every field is nullable
 * because a `skipped` row carries none of them — the required-when-`labeled` shape is a
 * discriminated union at the repository boundary, not a property of this type.
 */
export interface OutcomeLabelFields {
  taskType: TaskType | null;
  intent: string | null;
  outcome: LabelOutcome | null;
  /** §4.3 `quality_rating`, 1–5. A fast judgment of usefulness, not a score of the operator. */
  qualityRating: number | null;
  primaryFriction: Friction | null;
  followUpCommitOrPr: string | null;
}

/** Narrowing guard for a value arriving from the database as plain TEXT, or off the wire. */
export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

/** Narrowing guard for a value arriving from the database as plain TEXT, or off the wire. */
export function isLabelOutcome(value: string): value is LabelOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/** Narrowing guard. Rejects §4.3's un-normalized `model/tool` on purpose — see the header. */
export function isFriction(value: string): value is Friction {
  return (FRICTIONS as readonly string[]).includes(value);
}

/** Narrowing guard. NULL ("not stated") is not a member — check for it before calling. */
export function isLabelConfidence(value: string): value is LabelConfidence {
  return (LABEL_CONFIDENCE as readonly string[]).includes(value);
}

/** Narrowing guard for the `status` discriminator (D-16.1-2). */
export function isLabelStatus(value: string): value is LabelStatus {
  return (LABEL_STATUSES as readonly string[]).includes(value);
}

/** §4.3 `quality_rating` is 1–5 inclusive, integral. Rejects 0, 6 and every non-integer. */
export function isQualityRating(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}
