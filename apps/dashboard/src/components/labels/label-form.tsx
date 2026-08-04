"use client";

import { useState } from "react";
import {
  TASK_TYPES,
  OUTCOMES,
  FRICTIONS,
  LABEL_CONFIDENCE,
  INTENT_MAX_LENGTH,
  FOLLOW_UP_MAX_LENGTH,
} from "@420ai/shared/outcome-labels";
import { cn } from "@/lib/utils";
import {
  TASK_TYPE_LABELS,
  OUTCOME_LABELS,
  FRICTION_LABELS,
  CONFIDENCE_LABELS,
} from "@/lib/label-display";

/**
 * M16 16.2 — the §4.3 label form, shared by the `/labels` review table and the project session row.
 *
 * §4.3's FOUR RULES ARE ACCEPTANCE CRITERIA, NOT SUGGESTIONS (M16 plan, Risk 3 — if the 15-second
 * label is not actually 15 seconds, completion collapses and 16.4's outcome metrics have no
 * denominator). Each is implemented here and named where it lives:
 *
 *   1. OFFER SKIP — the parent renders it; this form's `onSkip` is always available and never
 *      hidden behind a confirm.
 *   2. NEVER NAG — a property of the QUEUE, not of this form (a skip is a row, D-16.1-2).
 *   3. ALWAYS EDITABLE — `initial` seeds an existing label, so this same component edits.
 *   4. NEUTRAL WORDING — every visible string comes from `label-display.ts`, which is unit-tested
 *      against that rule.
 *
 * NOTHING IS PRE-SELECTED WITH A GUESS. Every `<select>` starts on an empty option and submit is
 * disabled until the five required fields are chosen. A defaulted `outcome` would put a value no
 * human picked into the one table 16.4 reads as ground truth — the server makes the same argument
 * for the same reason (`routes/outcome-labels.ts`: "deliberately NOT defaulted to anything").
 *
 * A `1` IS AS EASY TO GIVE AS A `5`. The rating renders as five identical buttons with identical
 * styling; there is no red, no warning tint and no confirm on a low score. §4.3: "do not imply a
 * low rating is user failure." The field is labelled "Usefulness", never "Score".
 *
 * NATIVE `<select>`, NOT A SHADCN PRIMITIVE. This repo has exactly three UI primitives
 * (card/table/badge) and the `selectCls` idiom from `export/export-view.tsx`; running the shadcn
 * CLI mutates `tsconfig`/`globals.css`/`components.json` and can prompt (CLAUDE.md "Frontend
 * workspace").
 */

const selectCls = "border-border bg-background rounded-md border px-3 py-2 text-sm";
const inputCls = "border-border bg-background rounded-md border px-3 py-2 text-sm";
const labelCls = "text-muted-foreground mb-1 block text-xs font-medium";

/** The shape the form edits. All nullable — a skip carries none of them. */
export interface LabelFormValues {
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  confidence: string | null;
}

export const EMPTY_LABEL_FORM: LabelFormValues = {
  taskType: null,
  intent: null,
  outcome: null,
  qualityRating: null,
  primaryFriction: null,
  followUpCommitOrPr: null,
  confidence: null,
};

export function LabelForm({
  initial,
  busy,
  submitLabel = "Save label",
  onSubmit,
  onCancel,
  onSkip,
}: {
  initial: LabelFormValues;
  busy?: boolean;
  submitLabel?: string;
  onSubmit: (values: LabelFormValues) => void;
  onCancel?: () => void;
  /** §4.3 rule 1. Rendered whenever the parent supplies it — never behind a confirm. */
  onSkip?: () => void;
}) {
  const [v, setV] = useState<LabelFormValues>(initial);

  const set = <K extends keyof LabelFormValues>(k: K, value: LabelFormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: value }));

  const intentLength = v.intent?.length ?? 0;
  /**
   * The five §4.3 fields the server requires for a `labeled` row (`assertLabelShape`). Checked here
   * so the operator sees a disabled button rather than a 400 — the server remains the enforcement,
   * this is only the courtesy half (the same both-halves rule `team-view.tsx` states for roles).
   */
  const complete =
    !!v.taskType &&
    !!v.intent &&
    v.intent.trim().length > 0 &&
    !!v.outcome &&
    typeof v.qualityRating === "number" &&
    !!v.primaryFriction;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !busy) onSubmit(v);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="label-task-type">
            Task type
          </label>
          <select
            id="label-task-type"
            className={cn(selectCls, "w-full")}
            value={v.taskType ?? ""}
            onChange={(e) => set("taskType", e.target.value || null)}
          >
            {/* Empty and FIRST: no field is pre-filled with a guess. */}
            <option value="">Choose…</option>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls} htmlFor="label-outcome">
            Outcome
          </label>
          <select
            id="label-outcome"
            className={cn(selectCls, "w-full")}
            value={v.outcome ?? ""}
            onChange={(e) => set("outcome", e.target.value || null)}
          >
            <option value="">Choose…</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="label-intent">
          What were you trying to do?
        </label>
        <input
          id="label-intent"
          className={cn(inputCls, "w-full")}
          value={v.intent ?? ""}
          maxLength={INTENT_MAX_LENGTH}
          placeholder="One line is plenty"
          onChange={(e) => set("intent", e.target.value || null)}
        />
        {/* A live remaining count, so the 200-character bound is never a surprise 400. */}
        <p className="text-muted-foreground mt-1 text-xs">
          {INTENT_MAX_LENGTH - intentLength} characters left
        </p>
      </div>

      <div>
        {/* "Usefulness", never "Score" — the rating is about the WORK, not the operator (§4.3). */}
        <span className={labelCls}>Usefulness</span>
        <div className="flex items-center gap-1.5" role="group" aria-label="Usefulness, 1 to 5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={v.qualityRating === n}
              onClick={() => set("qualityRating", v.qualityRating === n ? null : n)}
              // IDENTICAL styling for every value. A 1 must be as easy to click as a 5 and must
              // carry no negative tint — §4.3, "do not imply a low rating is user failure".
              className={cn(
                "border-border rounded-md border px-3 py-1 text-sm font-medium transition-colors",
                v.qualityRating === n ? "bg-primary/15 text-primary" : "hover:bg-muted",
              )}
            >
              {n}
            </button>
          ))}
          <span className="text-muted-foreground ml-1 text-xs">
            {v.qualityRating === null ? "not rated" : `${v.qualityRating} of 5`}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="label-friction">
            What got in the way?
          </label>
          <select
            id="label-friction"
            className={cn(selectCls, "w-full")}
            value={v.primaryFriction ?? ""}
            onChange={(e) => set("primaryFriction", e.target.value || null)}
          >
            <option value="">Choose…</option>
            {FRICTIONS.map((f) => (
              <option key={f} value={f}>
                {FRICTION_LABELS[f]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls} htmlFor="label-confidence">
            Confidence <span className="text-muted-foreground">(optional)</span>
          </label>
          <select
            id="label-confidence"
            className={cn(selectCls, "w-full")}
            value={v.confidence ?? ""}
            onChange={(e) => set("confidence", e.target.value || null)}
          >
            {/* NULL is "not stated", which is deliberately distinct from `low` (D-16.1-8). */}
            <option value="">Not stated</option>
            {LABEL_CONFIDENCE.map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="label-followup">
          Commit, PR or issue <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          id="label-followup"
          className={cn(inputCls, "w-full font-mono text-xs")}
          value={v.followUpCommitOrPr ?? ""}
          maxLength={FOLLOW_UP_MAX_LENGTH}
          placeholder="git SHA, PR URL or issue id"
          onChange={(e) => set("followUpCommitOrPr", e.target.value || null)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!complete || busy}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            "bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50",
          )}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        {onSkip ? (
          // §4.3 rule 1: always offered, never behind a confirm, never styled as the lesser choice.
          <button
            type="button"
            disabled={busy}
            onClick={onSkip}
            className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Skip
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground px-2 py-1.5 text-sm transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
        {!complete ? (
          <span className="text-muted-foreground text-xs">
            Task type, outcome, intent, usefulness and friction are needed to save — or skip.
          </span>
        ) : null}
      </div>
    </form>
  );
}
