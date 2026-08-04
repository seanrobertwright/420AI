"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { buildDecisionStub } from "@/lib/decision-stub";
import { outcomeLabel, qualityStars } from "@/lib/label-display";
import {
  LabelForm,
  EMPTY_LABEL_FORM,
  toCreateLabelBody,
  type LabelFormValues,
} from "@/components/labels/label-form";

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

/**
 * The batched read's result. `truncated` is the load-bearing field.
 *
 * `LABEL_INDEX_LIMIT` is the server MAXIMUM (`listOutcomeLabelsQuerySchema` caps it at 200), and the
 * list is ordered by `updated_at DESC` — so once an org holds more than 200 labels, which is the
 * explicit goal of a 24-week research period, a label can simply fall off the page. A MISS in the
 * map then means one of two very different things, and they are indistinguishable from the map
 * alone: "no label exists" or "its label is older than the newest 200".
 *
 * Treating a truncated miss as `null` rendered a "Label" button over a session a colleague had
 * already judged, hid that judgement, and 409'd on submit — exactly the failure this file's
 * fallback exists to prevent. So a miss is only authoritative when `truncated` is false; otherwise
 * the caller falls through to the per-session read, whose 404 IS authoritative.
 */
const LABEL_INDEX_LIMIT = 200;
const LABEL_INDEX_TTL_MS = 30_000;

interface LabelIndex {
  bySession: Map<string, LabelRow>;
  truncated: boolean;
}

/** The single shared fetch. `null` = no cache; a promise = in flight or resolved. */
let labelIndexPromise: Promise<LabelIndex | null> | null = null;
let labelIndexAt = 0;

function loadLabelIndex(): Promise<LabelIndex | null> {
  const fresh = labelIndexPromise && Date.now() - labelIndexAt < LABEL_INDEX_TTL_MS;
  if (!fresh) {
    labelIndexAt = Date.now();
    labelIndexPromise = (async () => {
      try {
        const res = await fetch(`/api/labels?limit=${LABEL_INDEX_LIMIT}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { labels: LabelRow[] };
        const labels = body.labels ?? [];
        return {
          bySession: new Map(labels.map((l) => [l.sessionId, l])),
          truncated: labels.length >= LABEL_INDEX_LIMIT,
        };
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
  /**
   * `undefined` = still loading · `null` = no label (the authoritative 404) · a row = labeled or
   * skipped · `"error"` = the read FAILED and we do not know.
   *
   * The `"error"` state exists because the alternative was worse than it looked: a failed read used
   * to leave this `undefined`, which renders "…" — so with ingest down, EVERY session row in a
   * project showed a permanent silent spinner. That is the same "an unreachable archive is not zero
   * labels" argument `/labels/page.tsx` makes, which this file was not applying.
   */
  const [label, setLabel] = useState<LabelRow | null | undefined | "error">(undefined);
  /**
   * Mounted flag as a REF, not a local, so the post-mutation reloads are covered by the same guard
   * as the effect. Previously `create()`/`update()` called `load()` with the default
   * `isCancelled = () => false` while this file's header claimed "one predicate now covers the
   * batched read, the fallback fetch AND the post-mutation reload" — the comment was true of two
   * paths out of three, which is the M15 15.5 defect class the rest of this file is careful about.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stub, setStub] = useState<string | null>(null);

  /**
   * Resolve this row's label, batched read first.
   *
   * `isCancelled` IS THREADED THROUGH BOTH PATHS ON PURPOSE. An earlier version armed
   * `let cancelled = false` in the effect but then called an unguarded `load()` on the fallback
   * branch, so navigating away from a project page while a per-row fetch was in flight set state on
   * an unmounted island. React 18 no longer warns about that, which makes it quieter rather than
   * less real — and the file's header already CLAIMED the guard was in place, which is the worse
   * half (a comment asserting a mechanism it does not have is the M15 15.5 defect class). One
   * predicate now covers the batched read, the fallback fetch and the post-mutation reload.
   */
  const load = useCallback(
    async (isCancelled: () => boolean = () => !mounted.current): Promise<void> => {
      const index = await loadLabelIndex();
      if (isCancelled()) return;
      // A HIT is always authoritative. A MISS is only authoritative when the page was NOT truncated
      // — otherwise the label may simply be older than the newest 200 (see `LabelIndex`). Setting
      // it to `null` there would render a Label button that 409s on submit.
      if (index) {
        const hit = index.bySession.get(sessionId);
        if (hit) {
          setLabel(hit);
          return;
        }
        if (!index.truncated) {
          setLabel(null);
          return;
        }
        // truncated miss → fall through to the per-session read, whose 404 IS authoritative.
      }
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/label`);
        if (isCancelled()) return;
        if (res.status === 404) {
          setLabel(null);
          return;
        }
        if (!res.ok) {
          setLabel("error");
          return;
        }
        const body = (await res.json()) as { label: LabelRow };
        if (isCancelled()) return;
        setLabel(body.label);
      } catch {
        if (!isCancelled()) setLabel("error");
      }
    },
    [sessionId],
  );

  useEffect(() => {
    // The guard is the `mounted` ref above, armed before this effect ever runs and read by `load`
    // on every path — including the two post-mutation reloads.
    void load();
  }, [load]);

  /** POST a new label, or a skip when `values === null`. */
  async function create(values: LabelFormValues | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // NOT `{ status: "labeled", ...values }` — a spread carries `null` optionals, which this
      // endpoint rejects with a 400. `toCreateLabelBody` omits them; see its header for the
      // measurement and for why the POST/PATCH asymmetry is deliberate.
      const body = values === null ? { status: "skipped" } : toCreateLabelBody(values);
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
    // `"error"` and `null` both mean "no judgement to quote" — the stub still carries the session
    // id, which is the part §3 calls the link into the archive.
    const l = label && label !== "error" ? label : null;
    setStub(
      buildDecisionStub({
        sessionId,
        nowIso: new Date().toISOString(),
        taskType: l?.taskType ?? null,
        outcome: l?.outcome ?? null,
        primaryFriction: l?.primaryFriction ?? null,
        qualityRating: l?.qualityRating ?? null,
        confidence: l?.confidence ?? null,
      }),
    );
  }

  if (label === undefined) {
    return <span className="text-muted-foreground text-xs">…</span>;
  }

  if (label === "error") {
    // Say what happened and offer the retry, rather than a spinner that never resolves.
    return (
      <button type="button" className={btn} onClick={() => void load()}>
        label unavailable — retry
      </button>
    );
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
