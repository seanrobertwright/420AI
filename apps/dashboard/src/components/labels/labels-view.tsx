"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LABEL_STATUSES, OUTCOMES, TASK_TYPES } from "@420ai/shared/outcome-labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { FORBIDDEN_MESSAGE } from "@/lib/mutation-error";
import { buildDecisionStub } from "@/lib/decision-stub";
import {
  TASK_TYPE_LABELS,
  OUTCOME_LABELS,
  taskTypeLabel,
  outcomeLabel,
  frictionLabel,
  confidenceLabel,
  qualityStars,
} from "@/lib/label-display";
import { LabelForm, EMPTY_LABEL_FORM, type LabelFormValues } from "./label-form";

/**
 * M16 16.2 — the `/labels` review island. §7 P0.2's "edited, exported and deleted from a UI".
 *
 * MIRRORS `team/team-view.tsx` EXACTLY, because its shape encodes four lessons this file would
 * otherwise re-learn: a `useCallback` loader, a `let cancelled = false` teardown armed BEFORE the
 * first await resolves (CLAUDE.md's long-lived-resource rule — a disconnect during the initial
 * await fires before a later-attached guard exists), per-row `busy` keyed by id, and
 * `router.refresh()` PLUS a client re-fetch after every mutation.
 *
 * THE CLIENT RE-FETCH IS NOT REDUNDANT WITH `router.refresh()`. React ignores a changed `labels`
 * prop once this component is mounted, so the server page re-rendering does NOT update this table —
 * the prop is a FIRST-PAINT SEED and `reload()` owns every subsequent update. Drop the client
 * re-fetch and the table silently stops updating after the first edit.
 *
 * THE REFUSALS MEAN DIFFERENT THINGS AND MUST NOT BE COLLAPSED (D-16.1-4). There are FOUR, because
 * a PATCH 403 has two distinct sources — an earlier version of this file treated it as one and told
 * a `viewer` that only the author could edit, which was false and hid the real remedy:
 *   - PATCH 403 with `reason: "not_author"` — you may edit labels, just not THIS one. No rung
 *     overrides it, so "ask an admin" is the wrong advice and the copy says so specifically.
 *   - PATCH 403 without it (the route's role gate) — the account is below `member`. Reachable,
 *     because the READ is `viewer`-gated: a viewer can open this page and see an Edit button.
 *   - DELETE 404 — the row is not yours. Deliberately not 403, so a colleague's judgement is not
 *     disclosed by the refusal itself.
 *   - PATCH 400 — a partial patch against a SKIPPED row. The remedy is the upgrade path, and the
 *     UI states it rather than echoing a status code.
 *
 * NO QUEUE HERE, BY DESIGN (D-16.2-3). This page reviews labels that EXIST. The "which sessions
 * still need judging?" surface is the desktop panel, and putting a second one here would give the
 * product two places to nag from — the thing §4.3 forbids.
 */

interface LabelRow {
  id: string;
  sessionId: string;
  authorUserId: string;
  status: string;
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  confidence: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const selectCls = "border-border bg-background rounded-md border px-3 py-2 text-sm";
const btnCls =
  "border-border hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50";

/** A label row → the form's value shape. */
function toFormValues(l: LabelRow): LabelFormValues {
  return {
    taskType: l.taskType,
    intent: l.intent,
    outcome: l.outcome,
    qualityRating: l.qualityRating,
    primaryFriction: l.primaryFriction,
    followUpCommitOrPr: l.followUpCommitOrPr,
    confidence: l.confidence,
  };
}

export function LabelsView({ labels }: { labels: LabelRow[] }) {
  const router = useRouter();
  /** FIRST-PAINT SEED ONLY — see the header. `reload()` owns every subsequent update. */
  const [rows, setRows] = useState<LabelRow[]>(labels);
  const [status, setStatus] = useState("");
  const [outcome, setOutcome] = useState("");
  const [taskType, setTaskType] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The generated `DEC-` stub, held in memory for copying. Never persisted (D-16.2-6). */
  const [stub, setStub] = useState<{ sessionId: string; text: string } | null>(null);
  /** The list on screen could not be refreshed, so it may not reflect the filter or the last edit. */
  const [stale, setStale] = useState(false);

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (outcome) query.set("outcome", outcome);
  if (taskType) query.set("taskType", taskType);
  const search = query.toString();

  /**
   * `null` means THE READ FAILED — deliberately distinct from an empty array.
   *
   * Both used to be discarded by the callers, which produced two quiet lies: changing a filter
   * while ingest was unreachable left the PREVIOUS filter's rows on screen (read as filtered), and
   * a failed refresh after a successful PATCH left the stale row under a "Saved." notice (read as
   * the edit not landing). `stale` below is what makes the difference visible.
   */
  const reload = useCallback(async (qs: string): Promise<LabelRow[] | null> => {
    try {
      const res = await fetch(`/api/labels?limit=200${qs ? `&${qs}` : ""}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { labels: LabelRow[] };
      return body.labels ?? [];
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // Armed BEFORE the first await — a navigation during the fetch must not setState on an
    // unmounted island (CLAUDE.md; `team-view.tsx` shows the same `let cancelled` form).
    let cancelled = false;
    void reload(search).then((next) => {
      if (cancelled) return;
      // A failed filter read is NOT an empty result — leaving the old rows up would present the
      // previous filter's data as though the new filter had applied.
      if (next === null) {
        setStale(true);
        return;
      }
      setStale(false);
      setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, [reload, search]);

  async function refresh(): Promise<void> {
    const next = await reload(search);
    if (next === null) {
      setStale(true);
    } else {
      setStale(false);
      setRows(next);
    }
    router.refresh();
  }

  /** PATCH a label. `values === null` means "retract to skip". */
  async function save(sessionId: string, values: LabelFormValues | null): Promise<void> {
    setBusy(sessionId);
    setError(null);
    setNotice(null);
    try {
      const body =
        values === null
          ? { status: "skipped" }
          : // UPGRADING A SKIP SENDS THE FULL JUDGEMENT, not a partial patch: the repository
            // refuses §4.3 fields against a skipped row with a 400 by design, because a silent
            // no-op would rewrite the row all-NULL behind a 200 (the 16.1 prp-review finding).
            { status: "labeled", ...values };
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        /*
         * A PATCH 403 HAS TWO SOURCES AND THEY NEED DIFFERENT ADVICE.
         *   - the ROUTE's role gate → `{error: "insufficient role"}`: the account is below
         *     `member`. A `viewer` can open this page (the read is viewer-gated) and sees an Edit
         *     button, so this is reachable — and telling that person "only the author may edit"
         *     would be flatly false and would hide the real remedy.
         *   - the REPOSITORY's `not_author` → `{reason: "not_author"}` (mapped in app.ts): the
         *     account may edit labels, just not this one. No rung overrides it (D-16.1-4), so
         *     "ask an admin" is the wrong advice here and `FORBIDDEN_MESSAGE` must NOT be used.
         * The `reason` discriminator is what tells them apart; without it both collapse.
         */
        const body = (await res.json().catch(() => null)) as { reason?: string } | null;
        setError(
          res.status === 403
            ? body?.reason === "not_author"
              ? "Only the person who wrote this label can edit it. An admin can delete it, but nobody can rewrite it."
              : FORBIDDEN_MESSAGE
            : res.status === 400
              ? "This label is a skip. Fill in the whole judgement to turn it into a label."
              : res.status === 404
                ? "That label no longer exists."
                : `Save failed (${res.status}).`,
        );
        return;
      }
      setEditing(null);
      setNotice(values === null ? "Retracted to a skip." : "Saved.");
      await refresh();
    } catch {
      setError("Could not reach the archive.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(sessionId: string): Promise<void> {
    if (
      !window.confirm(
        "Delete this label and its full edit history? This cannot be undone. To retract a judgement while keeping its history, use “Retract to skip” instead.",
      )
    ) {
      return;
    }
    setBusy(sessionId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(
          res.status === 404
            ? // A non-author gets 404 rather than 403 on purpose — the row is not theirs and
              // confirming it exists would disclose a colleague's judgement.
              "No label of yours for that session. Only its author, or an admin, can delete it."
            : res.status === 403
              ? FORBIDDEN_MESSAGE
              : `Delete failed (${res.status}).`,
        );
        return;
      }
      setNotice("Deleted.");
      await refresh();
    } catch {
      setError("Could not reach the archive.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * §7 P1.5 — render a decision-log stub for this session.
   *
   * The label row is NOT spread into the builder: `buildDecisionStub` types `intent`,
   * `followUpCommitOrPr` and `projectPath` as `never`, so the fields are named one by one and a
   * spread would not compile (D-16.2-5). That is the mechanism — `decisions.md` is committed to a
   * public repository and free human text may not go there.
   */
  function logDecision(l: LabelRow): void {
    setStub({
      sessionId: l.sessionId,
      text: buildDecisionStub({
        sessionId: l.sessionId,
        nowIso: new Date().toISOString(),
        taskType: l.taskType,
        outcome: l.outcome,
        primaryFriction: l.primaryFriction,
        qualityRating: l.qualityRating,
        confidence: l.confidence,
      }),
    });
  }

  /**
   * The `api-keys-card.tsx` clipboard guard, verbatim in shape and for the same reason.
   *
   * `navigator.clipboard` is UNDEFINED outside a secure context, and `localhost` counts as secure —
   * so this works in dev and every test and still fails on the self-hosted box at
   * `http://192.168.x.x:3000`, which is this product's actual deployment shape. An optional call
   * (`?.writeText`) is WORSE than no guard: it resolves to `undefined` without throwing, the catch
   * never runs, and the button claims success having copied nothing. Detect the absence explicitly
   * and keep the stub on screen and selectable either way.
   */
  async function copyStub(): Promise<void> {
    if (!stub) return;
    if (!navigator.clipboard) {
      setError("Copying is unavailable here — select the text above and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(stub.text);
      setNotice("Stub copied. Paste it into .agents/research/decisions.md.");
    } catch {
      setError("Copy was blocked — select the text above and copy it manually.");
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>
            Labels{" "}
            <span className="text-muted-foreground text-sm font-normal">
              ({rows.length}
              {rows.length === 200 ? "+" : ""})
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={selectCls}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {LABEL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "labeled" ? "Labeled" : "Skipped"}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              aria-label="Filter by outcome"
            >
              <option value="">All outcomes</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={taskType}
              onChange={(e) => setTaskType(e.target.value)}
              aria-label="Filter by task type"
            >
              <option value="">All task types</option>
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {/* A plain link, so the browser downloads it — the stream proxy forwards
                content-disposition. `intent` is REDACTED in the export (D-16.1-7). */}
            <a
              className={btnCls}
              href={`/api/labels/export?format=csv${search ? `&${search}` : ""}`}
            >
              Export CSV
            </a>
          </div>
        </CardHeader>
        <CardContent>
          {error ? <p className="text-destructive mb-3 text-sm">{error}</p> : null}
          {notice ? <p className="text-muted-foreground mb-3 text-sm">{notice}</p> : null}
          {/* Distinct from `error`: the MUTATION may well have succeeded — it is the list that is
              stale. Saying "showing older data" is the honest version of silently leaving the
              previous filter's rows on screen. */}
          {stale ? (
            <p className="text-muted-foreground mb-3 text-sm">
              Could not reach the archive — showing older data, which may not match the filter
              above. Refresh to try again.
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No labels yet
              {search ? " for this filter" : ""}. Label a session from the desktop app, or from a
              project’s session list.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Usefulness</TableHead>
                  <TableHead>Friction</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell
                      className="max-w-[16rem] truncate font-mono text-xs"
                      title={l.sessionId}
                    >
                      {l.sessionId}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.status === "skipped" ? "Skipped" : "Labeled"}
                      {l.revision > 1 ? (
                        <span className="text-muted-foreground ml-1 text-xs">v{l.revision}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{taskTypeLabel(l.taskType)}</TableCell>
                    <TableCell className="text-sm">{outcomeLabel(l.outcome)}</TableCell>
                    <TableCell className="text-sm" title={confidenceLabel(l.confidence)}>
                      {qualityStars(l.qualityRating)}
                    </TableCell>
                    <TableCell className="text-sm">{frictionLabel(l.primaryFriction)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(l.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className={btnCls}
                          disabled={busy !== null}
                          onClick={() => setEditing(editing === l.sessionId ? null : l.sessionId)}
                        >
                          {editing === l.sessionId ? "Close" : "Edit"}
                        </button>
                        {l.status === "labeled" ? (
                          <button
                            type="button"
                            className={btnCls}
                            disabled={busy !== null}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Retract this judgement to a skip? The current row is blanked, but this revision stays readable in the label’s history.",
                                )
                              ) {
                                void save(l.sessionId, null);
                              }
                            }}
                          >
                            Retract to skip
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={btnCls}
                          disabled={busy !== null}
                          onClick={() => logDecision(l)}
                        >
                          Log a decision
                        </button>
                        <button
                          type="button"
                          className={cn(btnCls, "text-destructive")}
                          disabled={busy !== null}
                          onClick={() => void remove(l.sessionId)}
                        >
                          Delete
                        </button>
                      </div>
                      {editing === l.sessionId ? (
                        <div className="border-border mt-3 rounded-md border p-3">
                          {l.status === "skipped" ? (
                            <p className="text-muted-foreground mb-3 text-xs">
                              This session was skipped. Filling this in turns it into a label — the
                              skip stays in the history.
                            </p>
                          ) : null}
                          <LabelForm
                            initial={l.status === "skipped" ? EMPTY_LABEL_FORM : toFormValues(l)}
                            busy={busy === l.sessionId}
                            submitLabel={l.status === "skipped" ? "Turn into a label" : "Save"}
                            onSubmit={(values) => void save(l.sessionId, values)}
                            onCancel={() => setEditing(null)}
                          />
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {stub ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Decision stub for <span className="font-mono text-sm">{stub.sessionId}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Paste this into <span className="font-mono">.agents/research/decisions.md</span> and
              fill in the blanks. It carries IDs and the values you selected only — never the
              free-text intent or follow-up link, because that file is committed to a public
              repository.
            </p>
            {/* Rendered and selectable, so manual copying is a real fallback when the clipboard
                API is unavailable (non-secure context). */}
            <pre className="border-border bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
              {stub.text}
            </pre>
            <div className="flex items-center gap-2">
              <button type="button" className={btnCls} onClick={() => void copyStub()}>
                Copy
              </button>
              <button type="button" className={btnCls} onClick={() => setStub(null)}>
                Dismiss
              </button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
