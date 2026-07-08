"use client";

import { useEffect, useState } from "react";
import type { LiveMonitorSnapshot } from "@420ai/shared";
import { MonitorView } from "@/components/monitor/monitor-view";
import { OnboardingCard } from "@/components/monitor/onboarding-card";

/**
 * The live Live Monitor (M9). Seeded with the server-fetched `initial` snapshot (so the
 * first paint is real SSR data, never a spinner), then subscribes to the same-origin SSE
 * proxy `new EventSource("/api/monitor/stream")` and re-renders on every pushed snapshot.
 *
 * The admin token never reaches here: EventSource hits the Next proxy Route Handler, which
 * adds the bearer on the server→ingest hop (D8). A separate 1 s clock tick keeps the
 * "N s ago" labels honest (PRD §10.1.1) between snapshots. `connected` degrades the badge
 * if SSE drops (the snapshot REST endpoint remains the poll fallback).
 */
export function LiveMonitor({ initial }: { initial: LiveMonitorSnapshot }) {
  const [snapshot, setSnapshot] = useState<LiveMonitorSnapshot>(initial);
  const [connected, setConnected] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.parse(initial.generatedAt) || Date.now());

  // Subscribe to the SSE proxy; update state on each pushed snapshot.
  useEffect(() => {
    const source = new EventSource("/api/monitor/stream");
    source.onopen = () => setConnected(true);
    source.onmessage = (ev) => {
      try {
        setSnapshot(JSON.parse(ev.data) as LiveMonitorSnapshot);
        setConnected(true);
      } catch {
        /* ignore a malformed frame — the next tick recovers */
      }
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  // Tick a wall clock once a second so relative times advance between snapshots.
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Monitor</h1>
          <p className="text-muted-foreground text-sm">
            Real-time view over collectors, connectors, and active sessions.
          </p>
        </div>
        <span
          className={
            "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium " +
            (connected
              ? "border-transparent bg-emerald-500/15 text-emerald-400"
              : "border-transparent bg-amber-500/15 text-amber-400")
          }
          aria-live="polite"
        >
          <span
            className={"h-2 w-2 rounded-full " + (connected ? "bg-emerald-400" : "bg-amber-400")}
          />
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>
      {snapshot.machines.length === 0 ? (
        // First-run: no collector has paired yet — guide the operator instead of empty tables.
        <OnboardingCard />
      ) : (
        <MonitorView snapshot={snapshot} nowMs={nowMs} />
      )}
    </main>
  );
}
