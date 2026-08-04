"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { CaptureHealthRow, CaptureHealthSnapshot } from "@420ai/shared/capture-health";
import { CAPTURE_HEALTH_VERDICT } from "@420ai/shared/capture-health";
import { Badge } from "@/components/ui/badge";
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
import { formatAgo } from "@/lib/format";
import { FORBIDDEN_MESSAGE } from "@/lib/mutation-error";
import {
  STATE_DESCRIPTIONS,
  STATE_LABELS,
  VERDICT_LABELS,
  badgeClassForState,
} from "@/lib/capture-health-display";

/**
 * M16 16.3 — the capture health scorecard (research plan §7 P0.1).
 *
 * Replaces the thin Connectors card, which could only ever show connectors that PRODUCED events:
 * a broken connector emitted nothing and so had no row at all, byte-identical to one that was
 * disabled and to a healthy one on a quiet day. The whole acceptance criterion is that a user can
 * distinguish "no work happened" from "capture is broken".
 *
 * POLLED, NOT STREAMED, AND SLOWLY (60 s). The underlying signal changes at HEARTBEAT cadence
 * (30 s), not at the SSE tick's 3 s, so subscribing it to the live stream would multiply the cost of
 * the hottest query path in the product by a signal that cannot change that fast (D-16.3-5).
 *
 * TEARDOWN IS ARMED BEFORE THE FIRST AWAIT (`let cancelled = false` set synchronously, and the
 * interval cleared in the same cleanup). A disconnect during the initial fetch would otherwise fire
 * `close` before a later-attached listener existed, leaking the timer — CLAUDE.md's
 * long-lived-resource rule, and the exact class `/lril:code-review` caught in M9.
 *
 * NO DECIDABLE JUDGEMENT LIVES IN THIS FILE. The dashboard has no component-test lane, so the state
 * → label/tone maps are in `@/lib/capture-health-display` (unit-tested) and the state itself is
 * derived server-side by the pure `deriveCaptureHealth`. This component only arranges them.
 */

const REFRESH_MS = 60_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: CaptureHealthSnapshot }
  | { kind: "error"; message: string };

export function CaptureHealthPanel({ nowMs }: { nowMs: number }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetch("/api/capture-health");
      if (res.status === 403) return { kind: "error", message: FORBIDDEN_MESSAGE };
      if (res.status === 401) {
        return { kind: "error", message: "Your session has expired. Sign in again." };
      }
      // AN UNREACHABLE ARCHIVE IS NOT AN EMPTY SCORECARD. `proxyJson` forwards the upstream status,
      // so a 502 is distinguishable — and it must be, because a plausible-looking empty table here
      // is a lie about capture health, which is the one thing this panel exists to tell the truth
      // about.
      if (!res.ok) {
        return {
          kind: "error",
          message: "Could not reach the archive. Capture health is unknown.",
        };
      }
      return { kind: "ok", snapshot: (await res.json()) as CaptureHealthSnapshot };
    } catch {
      return { kind: "error", message: "Could not reach the archive. Capture health is unknown." };
    }
  }, []);

  useEffect(() => {
    // Armed SYNCHRONOUSLY, before the first await below can resolve.
    let cancelled = false;
    const run = () => {
      void load().then((next) => {
        if (!cancelled) setState(next);
      });
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Capture health</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === "loading" && (
          <p className="text-muted-foreground text-sm">Loading capture health…</p>
        )}
        {state.kind === "error" && <p className="text-destructive text-sm">{state.message}</p>}
        {state.kind === "ok" && (
          <CaptureHealthTable
            rows={state.snapshot.rows}
            nowMs={nowMs}
            expanded={expanded}
            onToggle={(key) => setExpanded((cur) => (cur === key ? null : key))}
          />
        )}
      </CardContent>
    </Card>
  );
}

const rowKey = (r: CaptureHealthRow): string => `${r.machineId}:${r.connectorId}`;

function CaptureHealthTable({
  rows,
  nowMs,
  expanded,
  onToggle,
}: {
  rows: CaptureHealthRow[];
  nowMs: number;
  expanded: string | null;
  onToggle: (key: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No collector has reported its connectors yet. Once a machine checks in, every connector
        appears here — including ones that have never captured anything.
      </p>
    );
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const v = CAPTURE_HEALTH_VERDICT[r.state];
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {/* The P0.1 distinction itself, summarised. `Can't tell` is shown even at zero, so the
          scorecard's ability to say "I don't know" is visible rather than implied. */}
      <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
        {(["capturing", "broken", "not-capturing", "unknown"] as const).map((v) => (
          <span key={v}>
            <span className="text-foreground font-medium">{counts[v] ?? 0}</span>{" "}
            {VERDICT_LABELS[v]}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Machine</TableHead>
              <TableHead>Connector</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Parser</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const key = rowKey(r);
              const isOpen = expanded === key;
              const hasDetail =
                r.requiredPermissions.length > 0 || r.knownGaps.length > 0 || !!r.lastErrorMessage;
              return (
                <Fragment key={key}>
                  <TableRow>
                    <TableCell className="text-muted-foreground text-xs">{r.machineName}</TableCell>
                    <TableCell className="font-medium">{r.connectorId}</TableCell>
                    <TableCell>
                      <Badge
                        className={cn(badgeClassForState(r.state))}
                        title={STATE_DESCRIPTIONS[r.state]}
                      >
                        {STATE_LABELS[r.state]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAgo(r.lastEventAt, nowMs)}
                    </TableCell>
                    <TableCell>{r.eventCount}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {r.parserVersions.length ? r.parserVersions.join(", ") : "—"}
                    </TableCell>
                    <TableCell>
                      {hasDetail ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground text-xs underline"
                          onClick={() => onToggle(key)}
                        >
                          {isOpen ? "Hide" : "Show"}
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/30 text-xs">
                        <div className="space-y-2 py-2">
                          <p className="text-muted-foreground">{STATE_DESCRIPTIONS[r.state]}</p>
                          {r.lastErrorMessage && (
                            <p className="text-destructive">
                              <span className="font-medium">Last error</span>
                              {r.lastErrorAt ? ` (${formatAgo(r.lastErrorAt, nowMs)})` : ""}:{" "}
                              {r.lastErrorMessage}
                              {r.errorCount > 1 ? ` — ${r.errorCount} occurrences` : ""}
                            </p>
                          )}
                          {r.requiredPermissions.length > 0 && (
                            <div>
                              <span className="font-medium">Reads</span>
                              <ul className="text-muted-foreground list-inside list-disc">
                                {r.requiredPermissions.map((p) => (
                                  <li key={p}>{p}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {r.knownGaps.length > 0 && (
                            <div>
                              <span className="font-medium">Known gaps</span>
                              <ul className="text-muted-foreground list-inside list-disc">
                                {r.knownGaps.map((g) => (
                                  <li key={g}>{g}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
