import { useCallback, useEffect, useState } from "react";
import type {
  Friction,
  LabelConfidence,
  LabelOutcome,
  LabelQueueRow,
  TaskType,
} from "@420ai/shared/outcome-labels";
/*
 * THE `/outcome-labels` SUBPATH, NEVER THE PACKAGE ROOT — and this is a VALUE import, which is what
 * makes it matter. Every other `@420ai/shared` import in `apps/desktop/src` is `import type` and
 * erases at compile time; this one does not. The root barrel `export *`s `fingerprint.ts` and
 * `catalog-signing.ts`, both of which `import … from "node:crypto"`, plus eight parsers — all of it
 * dragged into a Tauri WEBVIEW bundle that has no Node built-ins. `outcome-labels.ts` has no
 * imports at all. Same rule the dashboard's `lib/label-display.ts` states for the same reason.
 */
import {
  TASK_TYPES,
  OUTCOMES,
  FRICTIONS,
  LABEL_CONFIDENCE,
  INTENT_MAX_LENGTH,
  FOLLOW_UP_MAX_LENGTH,
} from "@420ai/shared/outcome-labels";
import { getLabelQueue, postSessionLabel, skipSession } from "@/lib/bridge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * M16 16.2 — "Sessions to label": the 15-second capture surface (research plan §4.3, §7 P0.2).
 *
 * ══ D-16.2-3 — THE ANTI-NAG CONTRACT. READ THIS BEFORE ADDING ANYTHING TO THIS FILE. ══
 *
 * This panel is PULL-ONLY. It MUST NOT call `getCurrentWindow().show()`, request notification
 * permission, raise or focus a window, play a sound, or poll on a timer. The tray's "Label
 * sessions…" item is the ONLY attention-getting affordance, and a human presses it.
 *
 * §4.3 requires "offer skip and do not nag repeatedly", and this is how that is made STRUCTURALLY
 * IMPOSSIBLE rather than merely tuned. The rejected alternative was one OS notification per settled
 * session: higher completion, but a genuine interruption during exactly the deep work being
 * measured — and a measurement that changes the thing it measures is worse than a lower completion
 * rate. The cost is stated honestly: completion depends on the operator opening an app they already
 * run. If it proves too low after two research weeks, the EVIDENCE for changing it will exist,
 * which is the scope-change rule (§2) working as designed.
 *
 * A later "improvement" that adds a notification has to argue with this paragraph first.
 *
 * NEVER NAGGING TWICE IS NOT IMPLEMENTED HERE EITHER. A skip is a ROW (D-16.1-2), so the server's
 * queue excludes it by the same `count(labels.id) = 0` predicate that excludes a judged session.
 * There is no "already asked" state in this component, and a reinstall cannot reset it.
 *
 * DEGRADES LIKE `SyncHealth`: a rejection from the Rust proxy (API key unset, ingest down) becomes
 * PANEL STATE, never an unhandled rejection, and the rest of the app keeps working. D-16.2-4's
 * `viewer`-key case is the one an upgrading operator will actually hit — the queue loads and the
 * submit 403s — and Rust maps that to a message naming the remedy.
 */

const selectCls = "border-border bg-background rounded-md border px-2 py-1.5 text-sm";
const inputCls = "border-border bg-background rounded-md border px-2 py-1.5 text-sm";
const btnCls =
  "border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";

/*
 * Human copy for the closed sets. Kept local — the desktop cannot import the dashboard's lib (they
 * are separate bundles with no shared UI package).
 *
 * KEYED ON THE EXACT UNIONS, not `Record<string, string>`. Adding a member to a shared array is a
 * research decision-log entry, i.e. a thing that WILL happen, and with a `string` key that addition
 * would render an `<option>` with a BLANK visible label that is still submittable — a silently
 * unlabeled choice in the one table 16.4 reads as ground truth. The dashboard's sibling has two
 * nets (the exact key type AND an exhaustiveness test); the desktop has NO test lane at all
 * (`vitest.config.ts` globs test files under `apps/`, and `apps/desktop/src` contains none), so
 * the key type is the only thing standing between that change and a blank dropdown entry.
 */
const TASK_TYPE_COPY: Record<TaskType, string> = {
  feature: "Feature",
  bug_fix: "Bug fix",
  investigation: "Investigation",
  refactor: "Refactor",
  test: "Test",
  documentation: "Documentation",
  incident: "Incident",
  other: "Other",
};
const OUTCOME_COPY: Record<LabelOutcome, string> = {
  shipped: "Shipped",
  useful_partial: "Useful but partial",
  blocked: "Blocked",
  abandoned: "Abandoned",
  // "Incorrect result", never "Failure" — §4.3 neutral wording: the statement is about the OUTPUT.
  incorrect: "Incorrect result",
};
const FRICTION_COPY: Record<Friction, string> = {
  none: "None",
  context: "Context",
  model_tool: "Model / tool",
  tool_failure: "Tool failure",
  unclear_task: "Unclear task",
  verification: "Verification",
  non_ai: "Not AI-related",
};
const CONFIDENCE_COPY: Record<LabelConfidence, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * The in-progress label.
 *
 * TYPED WITH THE SHARED UNIONS, not `string`, and `""` is the not-yet-chosen state. The earlier
 * version used `string` everywhere and reached the bridge through `as never` casts, which silenced
 * the mismatch instead of resolving it — in a slice whose whole design is "build the dropdowns from
 * the shared arrays, never re-type the strings". With `string` a typo here compiled fine and became
 * a 400 at runtime; now it is a compile error. The only remaining cast is at the `<select>`
 * boundary, where the DOM genuinely hands back a `string`.
 */
interface Draft {
  taskType: TaskType | "";
  intent: string;
  outcome: LabelOutcome | "";
  qualityRating: number | null;
  primaryFriction: Friction | "";
  followUpCommitOrPr: string;
  confidence: LabelConfidence | "";
}

const EMPTY_DRAFT: Draft = {
  taskType: "",
  intent: "",
  outcome: "",
  qualityRating: null,
  primaryFriction: "",
  followUpCommitOrPr: "",
  confidence: "",
};

/**
 * The server's `DEFAULT_QUEUE_LIMIT` (routes/outcome-labels.ts). Mirrored here ONLY so the count
 * can admit when it is capped — see the header render.
 *
 * NO SILENT CAPS (CLAUDE.md): with 60 settled sessions this panel receives 25 and would otherwise
 * render "Sessions to label (25)", a number an operator reads as the total. Labeling all 25 would
 * then reveal more, which reads as a bug rather than as paging.
 */
const QUEUE_PAGE_SIZE = 25;

/** Compact "2h ago" for the settle time, so the operator can tell which session this was. */
function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const delta = nowMs - Date.parse(iso);
  if (!Number.isFinite(delta)) return "—";
  const m = Math.max(0, Math.round(delta / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function LabelQueue() {
  const [queue, setQueue] = useState<LabelQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** One row expanded at a time — a list of open forms is a backlog, not a 15-second question. */
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A failed RELOAD after a successful write, kept separate from `error` on purpose.
   *
   * Both used to write to `error`, so a transient blip right after a save rendered "Thanks —
   * labeled." AND a red error under a "mint a member key" hint — which reads as "the save failed"
   * and invites a re-submit that then 409s. The write succeeded; only the list is stale.
   */
  const [staleList, setStaleList] = useState(false);

  const refresh = useCallback((): Promise<void> => {
    setLoading(true);
    return getLabelQueue()
      .then((res) => {
        setQueue(res.sessions ?? []);
        setError(null);
        setStaleList(false);
      })
      .catch(() => setStaleList(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // ON MOUNT ONLY — no interval. A poll would make the panel change while the operator is
    // looking elsewhere, which is the soft form of nagging (D-16.2-3). The teardown guard is armed
    // before the first await resolves (CLAUDE.md leak-window discipline).
    let cancelled = false;
    void getLabelQueue()
      .then((res) => {
        if (cancelled) return;
        setQueue(res.sessions ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nowMs = Date.now();

  const complete =
    draft.taskType !== "" &&
    draft.intent.trim() !== "" &&
    draft.outcome !== "" &&
    draft.qualityRating !== null &&
    draft.primaryFriction !== "";

  async function submit(sessionId: string): Promise<void> {
    // The same predicate as `complete`, written so the COMPILER can see it: these four narrow
    // `Draft`'s `T | ""` fields to `T`, which is what removes the old `as never` casts.
    if (
      !draft.taskType ||
      !draft.outcome ||
      !draft.primaryFriction ||
      draft.qualityRating === null
    ) {
      return;
    }
    setBusy(sessionId);
    setError(null);
    setNotice(null);
    try {
      /*
       * ── AN UNSET OPTIONAL IS AN ABSENT KEY, NOT `null`. THIS IS A MEASURED CONTRACT. ──
       *
       * `createOutcomeLabelBodySchema` types `followUpCommitOrPr` and `confidence` as
       * `type: "string"` with NO null member, unlike its PATCH sibling which allows
       * `["string", "null"]`. Fastify's default ajv COERCES `null` to `""`, which then fails
       * `minLength: 1` and the `enum` respectively.
       *
       * Measured, because reading the schema does not predict the mechanism:
       *   both null      → 400 "body/followUpCommitOrPr must NOT have fewer than 1 characters"
       *   confidence null→ 400 "body/confidence must be equal to one of the allowed values"
       *   both omitted   → 201
       *
       * That made the panel's DEFAULT path a 400 — most 15-second labels leave both blank. The
       * asymmetry with PATCH is correct and deliberate (a POST has no prior value to clear, so
       * `null` and absent would mean the same thing), so the fix belongs here, not in the schema.
       * Pinned by `outcome-labels.int.test.ts`.
       */
      const body: Parameters<typeof postSessionLabel>[1] = {
        status: "labeled",
        taskType: draft.taskType,
        intent: draft.intent,
        outcome: draft.outcome,
        qualityRating: draft.qualityRating,
        primaryFriction: draft.primaryFriction,
      };
      const followUp = draft.followUpCommitOrPr.trim();
      if (followUp) body.followUpCommitOrPr = followUp;
      if (draft.confidence) body.confidence = draft.confidence;
      await postSessionLabel(sessionId, body);
      setOpen(null);
      setDraft(EMPTY_DRAFT);
      setNotice("Thanks — labeled.");
      // The row must disappear; the server decides that, so re-read rather than splicing locally.
      await refresh();
    } catch (err: unknown) {
      // Rust already turned a 403 into the mint-a-`member`-key remedy (D-16.2-4).
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function skip(sessionId: string): Promise<void> {
    setBusy(sessionId);
    setError(null);
    setNotice(null);
    try {
      await skipSession(sessionId);
      setOpen(null);
      setDraft(EMPTY_DRAFT);
      // Say what a skip MEANS, because the honest answer is reassuring: it is not a deferral.
      setNotice("Skipped — you will not be asked about this session again.");
      await refresh();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Sessions to label{" "}
          {queue && queue.length > 0 ? (
            <span className="text-muted-foreground text-sm font-normal">
              ({queue.length}
              {queue.length === QUEUE_PAGE_SIZE ? "+" : ""})
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Finished sessions from the last two weeks. About 15 seconds each — or skip, and it will
          not come back.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div className="text-sm">
            <p className="text-destructive">{error}</p>
            {/* THE RUNG REMEDY IS FOR THE 403 ONLY. It used to render under every error, so
                "ingest unreachable" and "already has a label" both came with advice to re-mint a
                key — the same collapsing of distinct refusals that `label_write_error` goes out of
                its way to avoid on the Rust side. Keyed on the phrase Rust emits for a 403. */}
            {error.includes("read-only") ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Labelling needs an API key with the <span className="font-mono">member</span> rung.
                Capture keeps running either way.
              </p>
            ) : null}
          </div>
        ) : null}
        {staleList ? (
          <p className="text-muted-foreground text-sm">
            Saved — but the list could not be refreshed. Press Refresh to re-read the queue.
          </p>
        ) : null}
        {notice ? <p className="text-muted-foreground text-sm">{notice}</p> : null}

        {queue === null && !error ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : null}

        {queue !== null && queue.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing to label. You are up to date.</p>
        ) : null}

        {queue?.map((s) => (
          <div key={s.sessionId} className="border-border rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs" title={s.sessionId}>
                  {s.sessionId}
                </p>
                <p className="text-muted-foreground text-xs">
                  {s.sourceConnector} · {s.eventCount} events · {ago(s.lastEventAt, nowMs)}
                  {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={btnCls}
                  disabled={busy !== null}
                  onClick={() => {
                    setOpen(open === s.sessionId ? null : s.sessionId);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  {open === s.sessionId ? "Close" : "Label"}
                </button>
                {/* §4.3 rule 1: always offered, one click, never behind a confirm, and never
                    styled as the lesser choice. */}
                <button
                  type="button"
                  className={btnCls}
                  disabled={busy !== null}
                  onClick={() => void skip(s.sessionId)}
                >
                  Skip
                </button>
              </div>
            </div>

            {open === s.sessionId ? (
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(s.sessionId);
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className={selectCls}
                    value={draft.taskType}
                    onChange={(e) =>
                      setDraft({ ...draft, taskType: e.target.value as TaskType | "" })
                    }
                    aria-label="Task type"
                  >
                    {/* Empty and first — NO field is pre-filled with a guess (§4.3, D-16.1-8). */}
                    <option value="">Task type…</option>
                    {TASK_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TASK_TYPE_COPY[t]}
                      </option>
                    ))}
                  </select>
                  <select
                    className={selectCls}
                    value={draft.outcome}
                    onChange={(e) =>
                      setDraft({ ...draft, outcome: e.target.value as LabelOutcome | "" })
                    }
                    aria-label="Outcome"
                  >
                    <option value="">Outcome…</option>
                    {OUTCOMES.map((o) => (
                      <option key={o} value={o}>
                        {OUTCOME_COPY[o]}
                      </option>
                    ))}
                  </select>
                </div>

                <input
                  className={cn(inputCls, "w-full")}
                  value={draft.intent}
                  maxLength={INTENT_MAX_LENGTH}
                  placeholder="What were you trying to do?"
                  onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
                  aria-label="Intent"
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  {/* "Usefulness", never "Score". Every button is styled identically — a 1 must be
                      as easy to give as a 5 (§4.3: do not imply a low rating is user failure). */}
                  <span className="text-muted-foreground mr-1 text-xs">Usefulness</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={draft.qualityRating === n}
                      onClick={() =>
                        setDraft({ ...draft, qualityRating: draft.qualityRating === n ? null : n })
                      }
                      className={cn(
                        "border-border rounded-md border px-2.5 py-1 text-sm font-medium transition-colors",
                        draft.qualityRating === n ? "bg-primary/15 text-primary" : "hover:bg-muted",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className={selectCls}
                    value={draft.primaryFriction}
                    onChange={(e) =>
                      setDraft({ ...draft, primaryFriction: e.target.value as Friction | "" })
                    }
                    aria-label="Primary friction"
                  >
                    <option value="">What got in the way?…</option>
                    {FRICTIONS.map((f) => (
                      <option key={f} value={f}>
                        {FRICTION_COPY[f]}
                      </option>
                    ))}
                  </select>
                  <select
                    className={selectCls}
                    value={draft.confidence}
                    onChange={(e) =>
                      setDraft({ ...draft, confidence: e.target.value as LabelConfidence | "" })
                    }
                    aria-label="Confidence (optional)"
                  >
                    {/* NULL is "not stated", deliberately distinct from `low` (D-16.1-8). */}
                    <option value="">Confidence (optional)</option>
                    {LABEL_CONFIDENCE.map((c) => (
                      <option key={c} value={c}>
                        {CONFIDENCE_COPY[c]}
                      </option>
                    ))}
                  </select>
                </div>

                <input
                  className={cn(inputCls, "w-full font-mono text-xs")}
                  value={draft.followUpCommitOrPr}
                  maxLength={FOLLOW_UP_MAX_LENGTH}
                  placeholder="Commit, PR or issue (optional)"
                  onChange={(e) => setDraft({ ...draft, followUpCommitOrPr: e.target.value })}
                  aria-label="Follow-up commit or PR (optional)"
                />

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={!complete || busy !== null}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      "bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50",
                    )}
                  >
                    {busy === s.sessionId ? "Saving…" : "Save label"}
                  </button>
                  {!complete ? (
                    <span className="text-muted-foreground text-xs">
                      Task, outcome, intent, usefulness and friction — or skip.
                    </span>
                  ) : null}
                </div>
              </form>
            ) : null}
          </div>
        ))}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className={btnCls}
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
