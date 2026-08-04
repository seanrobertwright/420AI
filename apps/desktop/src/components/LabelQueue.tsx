import { useCallback, useEffect, useState } from "react";
import type { LabelQueueRow } from "@420ai/shared";
import {
  TASK_TYPES,
  OUTCOMES,
  FRICTIONS,
  LABEL_CONFIDENCE,
  INTENT_MAX_LENGTH,
} from "@420ai/shared";
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

/** Human copy for the closed sets. Kept local — the desktop does not import the dashboard's lib. */
const TASK_TYPE_COPY: Record<string, string> = {
  feature: "Feature",
  bug_fix: "Bug fix",
  investigation: "Investigation",
  refactor: "Refactor",
  test: "Test",
  documentation: "Documentation",
  incident: "Incident",
  other: "Other",
};
const OUTCOME_COPY: Record<string, string> = {
  shipped: "Shipped",
  useful_partial: "Useful but partial",
  blocked: "Blocked",
  abandoned: "Abandoned",
  // "Incorrect result", never "Failure" — §4.3 neutral wording: the statement is about the OUTPUT.
  incorrect: "Incorrect result",
};
const FRICTION_COPY: Record<string, string> = {
  none: "None",
  context: "Context",
  model_tool: "Model / tool",
  tool_failure: "Tool failure",
  unclear_task: "Unclear task",
  verification: "Verification",
  non_ai: "Not AI-related",
};
const CONFIDENCE_COPY: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

interface Draft {
  taskType: string;
  intent: string;
  outcome: string;
  qualityRating: number | null;
  primaryFriction: string;
  followUpCommitOrPr: string;
  confidence: string;
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

  const refresh = useCallback((): Promise<void> => {
    setLoading(true);
    return getLabelQueue()
      .then((res) => {
        setQueue(res.sessions ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
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
    if (!complete) return;
    setBusy(sessionId);
    setError(null);
    setNotice(null);
    try {
      await postSessionLabel(sessionId, {
        status: "labeled",
        taskType: draft.taskType as never,
        intent: draft.intent,
        outcome: draft.outcome as never,
        qualityRating: draft.qualityRating,
        primaryFriction: draft.primaryFriction as never,
        // Optional fields: an empty box is NOT STATED, which is null — never an empty string.
        followUpCommitOrPr: draft.followUpCommitOrPr.trim() || null,
        confidence: draft.confidence || null,
      });
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
            <span className="text-muted-foreground text-sm font-normal">({queue.length})</span>
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
            <p className="text-muted-foreground mt-1 text-xs">
              Labelling needs an API key with the <span className="font-mono">member</span> rung.
              Capture keeps running either way.
            </p>
          </div>
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
                    onChange={(e) => setDraft({ ...draft, taskType: e.target.value })}
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
                    onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
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
                    onChange={(e) => setDraft({ ...draft, primaryFriction: e.target.value })}
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
                    onChange={(e) => setDraft({ ...draft, confidence: e.target.value })}
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
