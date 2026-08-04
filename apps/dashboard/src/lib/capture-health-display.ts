import type { CaptureHealthState, CaptureHealthVerdict } from "@420ai/shared/capture-health";

/**
 * M16 16.3 — pure presentation maps for the capture health scorecard.
 *
 * KEYED ON THE SHARED UNION, so adding a state to `@420ai/shared` is a COMPILE ERROR here rather
 * than a blank cell in the UI. The dashboard has no component-test lane (only `src/lib/*.test.ts`),
 * which is exactly why every decidable judgement about how a state reads lives in this file instead
 * of inside the `.tsx`.
 *
 * THE WORDING IS DELIBERATELY NEUTRAL AND IS PART OF THE SLICE'S POINT. `idle` reads "No recent
 * activity", never "Nothing captured" — the whole acceptance criterion is that a quiet week is
 * legible as a fact about the week rather than as a failure. And `unreported`/`unknown` must never
 * be styled as either success or failure: a scorecard that renders "I don't know" as green converts
 * an outage into evidence (M16 Risk 2), and rendering it as red trains the operator to ignore it.
 */

/** Tone is a semantic class, NOT a colour: `neutral` is what the two "cannot tell" states get. */
export type CaptureHealthTone = "success" | "failure" | "warning" | "neutral" | "muted";

export const STATE_LABELS = {
  healthy: "Capturing",
  idle: "Idle",
  erroring: "Error",
  "needs-approval": "Needs approval",
  disabled: "Disabled",
  silent: "Silent",
  unreported: "Not reported",
  unknown: "Unknown",
} as const satisfies Record<CaptureHealthState, string>;

export const STATE_DESCRIPTIONS = {
  healthy: "Recent events captured from this connector.",
  idle: "No recent activity. Nothing suggests capture is broken.",
  erroring: "The collector reported an error after the last successful capture.",
  "needs-approval":
    "Withheld from capture until its capture scope is re-approved on the desktop app.",
  disabled: "Turned off in the collector's connector settings. No capture is expected.",
  silent: "No activity while other connectors on this machine captured. Worth checking.",
  unreported:
    "This collector does not report connector health yet — upgrade it to see this connector's state.",
  unknown: "This machine has not checked in recently, so its report may be out of date.",
} as const satisfies Record<CaptureHealthState, string>;

export const STATE_TONE = {
  healthy: "success",
  idle: "muted",
  erroring: "failure",
  "needs-approval": "warning",
  disabled: "muted",
  silent: "warning",
  // NEITHER success NOR failure — see the header. These are the Risk 2 mitigation.
  unreported: "neutral",
  unknown: "neutral",
} as const satisfies Record<CaptureHealthState, CaptureHealthTone>;

export const TONE_BADGE_CLASS = {
  success: "border-transparent bg-emerald-500/15 text-emerald-400",
  failure: "border-transparent bg-destructive/15 text-destructive",
  warning: "border-transparent bg-amber-500/15 text-amber-400",
  neutral: "border-transparent bg-sky-500/15 text-sky-300",
  muted: "border-transparent bg-muted text-muted-foreground",
} as const satisfies Record<CaptureHealthTone, string>;

/** How the P0.1 verdict itself reads, for the summary row above the table. */
export const VERDICT_LABELS = {
  capturing: "Capturing",
  "not-capturing": "Off by choice",
  broken: "Needs attention",
  unknown: "Can't tell",
} as const satisfies Record<CaptureHealthVerdict, string>;

export const badgeClassForState = (s: CaptureHealthState): string =>
  TONE_BADGE_CLASS[STATE_TONE[s]];

/**
 * Tally rows by VERDICT for the summary line above the table (PR #77 review).
 *
 * Lives here, not in the `.tsx`, because it is a decidable judgement and the dashboard has no
 * component-test lane — the panel's own header asserts that no such judgement lives in that file,
 * and the tally was quietly making that comment false.
 *
 * READS `row.verdict` rather than re-deriving it from `row.state`. The server already stamped it
 * from `CAPTURE_HEALTH_VERDICT`; recomputing here would be a second derivation of one number that
 * can only ever agree or silently disagree.
 *
 * Every verdict is present in the result even at ZERO, deliberately: "Can't tell: 0" is the
 * scorecard visibly demonstrating it CAN say "I don't know", which is the M16 Risk 2 mitigation. A
 * count that only appears when non-zero would hide the capability exactly when things look fine.
 */
export function summarizeVerdicts(
  rows: { verdict: CaptureHealthVerdict }[],
): Record<CaptureHealthVerdict, number> {
  const counts: Record<CaptureHealthVerdict, number> = {
    capturing: 0,
    "not-capturing": 0,
    broken: 0,
    unknown: 0,
  };
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return counts;
}
