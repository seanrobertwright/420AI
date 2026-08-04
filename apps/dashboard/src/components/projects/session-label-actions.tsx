"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { buildDecisionStub } from "@/lib/decision-stub";
import { outcomeLabel, qualityStars } from "@/lib/label-display";
import { LabelForm, EMPTY_LABEL_FORM, type LabelFormValues } from "@/components/labels/label-form";

/**
 * M16 16.2 — the per-session label affordance in a project's Sessions table. §4.3's "always
 * editable", reached from the place the evidence is already on screen.
 *
 * ── ONE REQUEST, NOT N. THIS IS WHY THE MODULE-SCOPED CACHE EXISTS. ──
 *
 * `project-detail-view.tsx` is a SERVER Component, so there is no client parent to hold shared
 * state and no place to thread a prop down from — every row would otherwise mount its own island
 * and fire `GET /api/sessions/:id/label`, i.e. N parallel requests on page load for a project with
 * N sessions. Each of those is a full Next→ingest→Postgres round trip.
 *
 * So the islands share ONE in-flight promise for `GET /api/labels?limit=200` (a filter the API
 * already supports) and index it by session id. Whichever row mounts first starts the fetch; the
 * rest await the same promise. The alternative — restructuring the sessions table into a client
 * component purely to hoist a fetch — would move a large server-rendered table into the browser
 * bundle to solve a request-count problem, which is the worse trade.
 *
 * THE CACHE IS INVALIDATED ON EVERY MUTATION, not merely aged out. `invalidate()` runs after any
 * successful write here, so the next read re-fetches; the TTL is a backstop for a label written on
 * ANOTHER surface (the desktop panel, or a second tab), not the primary freshness mechanism.
 *
 * A 404 FROM `GET …/label` IS THE EXPECTED ANSWER, not an error — most sessions carry no label.
 * That is the same shape as `team-view.tsx` treating a 403 on invites as "no panel". It is never
 * logged and never shown as a failure; it renders the "Label" button.
 */

interface LabelRow {
  sessionId: string;
  status: string;
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  confidence: string | null;
  revision: number;
}

/** The single shared fetch. `null` = no cache; a promise = in flight or resolved. */
let labelIndexPromise: Promise<Map<string, LabelRow> | null> | null = null;
let labelIndexAt = 0;
const LABEL_INDEX_TTL_MS = 30_000;

function loadLabelIndex(): Promise<Map<string, LabelRow> | null> {
  const fresh = labelIndexPromise && Date.now() - labelIndexAt < LABEL_INDEX_TTL_MS;
  if (!fresh) {
    labelIndexAt = Date.now();
    labelIndexPromise = (async () => {
      try {
        const res = await fetch("/api/labels?limit=200");
        if (!res.ok) return null;
        const body = (await res.json()) as { labels: LabelRow[] };
        return new Map((body.labels ?? []).map((l) => [l.sessionId, l]));
      } catch {
        return null;
      }
    })();
  }
  return labelIndexPromise!;
}

/** Drop the shared cache so the next mount re-reads. Called after every successful write. */
function invalidate(): void {
  labelIndexPromise = null;
  labelIndexAt = 0;
}

const btn = cn(
  "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
  "border-border hover:bg-muted disabled:opacity-50",
);

export function SessionLabelActions({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  /** `undefined` = still loading · `null` = no label (the 404 case) · a row = labeled/skipped. */
  const [label, setLabel] = useState<LabelRow | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stub, setStub] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const index = await loadLabelIndex();
    // A failed shared read is NOT "no label" — leaving it `undefined` would render a Label button
    // that 409s on submit. Fall back to the single-session read, whose 404 is authoritative.
    if (index) {
      setLabel(index.get(sessionId) ?? null);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`);
      if (res.status === 404) {
        setLabel(null);
        return;
      }
      if (!res.ok) return;
      setLabel(((await res.json()) as { label: LabelRow }).label);
    } catch {
      /* leave `undefined`: unknown, so no affordance is offered rather than a wrong one */
    }
  }, [sessionId]);

  useEffect(() => {
    // Teardown armed BEFORE the first await resolves (CLAUDE.md long-lived-resource rule).
    let cancelled = false;
    void loadLabelIndex().then((index) => {
      if (cancelled) return;
      if (index) {
        setLabel(index.get(sessionId) ?? null);
        return;
      }
      void load();
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, load]);

  /** POST a new label, or a skip when `values === null`. */
  async function create(values: LabelFormValues | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body = values === null ? { status: "skipped" } : { status: "labeled", ...values };
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "read-only account"
            : // D-16.1-3: one label per session; a second author is a conflict, not a second row.
              res.status === 409
              ? "already labeled"
              : res.status === 404
                ? "no events"
                : `failed (${res.status})`,
        );
        return;
      }
      invalidate();
      setOpen(false);
      await load();
      router.refresh();
    } catch {
      setError("unreachable");
    } finally {
      setBusy(false);
    }
  }

  /** PATCH an existing one. Upgrading a skip sends the FULL judgement (a partial patch is a 400). */
  async function update(values: LabelFormValues): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "labeled", ...values }),
      });
      if (!res.ok) {
        // 403 here is author-only (D-16.1-4), which no rung overrides — "not yours", not "ask an
        // admin". The full explanation lives on `/labels`; this cell has room for the short form.
        setError(res.status === 403 ? "not your label" : `failed (${res.status})`);
        return;
      }
      invalidate();
      setOpen(false);
      await load();
      router.refresh();
    } catch {
      setError("unreachable");
    } finally {
      setBusy(false);
    }
  }

  /**
   * §7 P1.5. The label's fields are named ONE BY ONE rather than spread: `buildDecisionStub` types
   * `intent`/`followUpCommitOrPr`/`projectPath` as `never`, so a spread would not compile
   * (D-16.2-5) — `decisions.md` is committed to a public repository.
   */
  function logDecision(): void {
    setStub(
      buildDecisionStub({
        sessionId,
        nowIso: new Date().toISOString(),
        taskType: label?.taskType ?? null,
        outcome: label?.outcome ?? null,
        primaryFriction: label?.primaryFriction ?? null,
        qualityRating: label?.qualityRating ?? null,
        confidence: label?.confidence ?? null,
      }),
    );
  }

  if (label === undefined) {
    return <span className="text-muted-foreground text-xs">…</span>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {label === null ? (
          <button type="button" className={btn} disabled={busy} onClick={() => setOpen(!open)}>
            {open ? "Close" : "Label"}
          </button>
        ) : (
          <>
            <span className="text-xs">
              {label.status === "skipped" ? (
                <span className="text-muted-foreground">Skipped</span>
              ) : (
                <>
                  {outcomeLabel(label.outcome)}{" "}
                  <span className="text-muted-foreground">{qualityStars(label.qualityRating)}</span>
                </>
              )}
            </span>
            <button type="button" className={btn} disabled={busy} onClick={() => setOpen(!open)}>
              {open ? "Close" : "Edit"}
            </button>
          </>
        )}
        {/* §4.3 rule 1 — a one-click skip, offered before any form is opened. */}
        {label === null ? (
          <button type="button" className={btn} disabled={busy} onClick={() => void create(null)}>
            Skip
          </button>
        ) : null}
        <button type="button" className={btn} disabled={busy} onClick={logDecision}>
          Decision
        </button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </div>

      {open ? (
        <div className="border-border rounded-md border p-3">
          <LabelForm
            initial={
              label === null || label.status === "skipped"
                ? EMPTY_LABEL_FORM
                : {
                    taskType: label.taskType,
                    intent: label.intent,
                    outcome: label.outcome,
                    qualityRating: label.qualityRating,
                    primaryFriction: label.primaryFriction,
                    followUpCommitOrPr: label.followUpCommitOrPr,
                    confidence: label.confidence,
                  }
            }
            busy={busy}
            submitLabel={label === null ? "Save label" : "Save"}
            onSubmit={(values) => void (label === null ? create(values) : update(values))}
            onCancel={() => setOpen(false)}
            onSkip={label === null ? () => void create(null) : undefined}
          />
        </div>
      ) : null}

      {stub ? (
        <div className="border-border rounded-md border p-2">
          <p className="text-muted-foreground mb-1 text-xs">
            Paste into <span className="font-mono">.agents/research/decisions.md</span> — IDs and
            selected values only.
          </p>
          {/* Selectable text, so manual copying works where the clipboard API does not. */}
          <pre className="bg-muted/40 max-h-52 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
            {stub}
          </pre>
          <button type="button" className={btn} onClick={() => setStub(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
