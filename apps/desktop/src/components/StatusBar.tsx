import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ControlCommand, ControlEvent } from "@420ai/shared";
import { onControlEvent, sendCommand } from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type CaptureState = "running" | "paused" | "idle" | "error" | "connecting";

interface StatusView {
  state: CaptureState;
  pending: number;
  inflight: number;
  lastSyncAt: string | null;
  collectorVersion: string | null;
  paired: boolean;
}

const INITIAL: StatusView = {
  state: "connecting",
  pending: 0,
  inflight: 0,
  lastSyncAt: null,
  collectorVersion: null,
  paired: false,
};

const STATE_BADGE: Record<
  CaptureState,
  { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
> = {
  running: { variant: "default", label: "running" },
  paused: { variant: "secondary", label: "paused" },
  idle: { variant: "outline", label: "idle" },
  error: { variant: "destructive", label: "error" },
  connecting: { variant: "outline", label: "connecting…" },
};

/**
 * The Slice-1 control surface: live capture status + Start/Pause/Resume. Subscribes
 * to the Rust-relayed `control-event` stream and folds each `ready`/`status` event
 * into a view. The async `listen` subscription is torn down even if the component
 * unmounts before it resolves (the `disposed` flag + immediate-unlisten), mirroring
 * the dashboard SSE leak-window discipline (CLAUDE.md "long-lived resource").
 */
export function StatusBar() {
  const [view, setView] = useState<StatusView>(INITIAL);
  const [lastError, setLastError] = useState<string | null>(null);

  // Every command can reject (e.g. "sidecar not running" during a restart window) —
  // surface it instead of leaking an unhandled promise rejection. A successful send
  // clears the prior error.
  const run = (cmd: ControlCommand): void => {
    setLastError(null);
    sendCommand(cmd).catch((err) => setLastError(String(err)));
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const apply = (ev: ControlEvent): void => {
      setView((prev) => {
        switch (ev.type) {
          case "ready":
            return { ...prev, collectorVersion: ev.collectorVersion, paired: ev.paired };
          case "status":
            return {
              ...prev,
              state: ev.state,
              pending: ev.pending,
              inflight: ev.inflight,
              lastSyncAt: ev.lastSyncAt ?? null,
            };
          default:
            return prev;
        }
      });
    };

    onControlEvent(apply).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    // Ask for an immediate snapshot so the panel isn't blank until the next tick.
    run({ cmd: "status" });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const badge = STATE_BADGE[view.state];
  const canStart = view.state === "idle" || view.state === "error";
  const canPause = view.state === "running";
  const canResume = view.state === "paused";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Capture
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </CardTitle>
            <CardDescription>
              {view.paired ? "paired" : "not paired"}
              {view.collectorVersion ? ` · collector v${view.collectorVersion}` : ""}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <ControlButton
              label="Start"
              disabled={!canStart}
              onClick={() => run({ cmd: "start" })}
            />
            <ControlButton
              label="Pause"
              disabled={!canPause}
              onClick={() => run({ cmd: "pause" })}
            />
            <ControlButton
              label="Resume"
              disabled={!canResume}
              onClick={() => run({ cmd: "resume" })}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <Stat label="pending" value={view.pending} />
          <Stat label="inflight" value={view.inflight} />
          <Stat
            label="last sync"
            value={view.lastSyncAt ? new Date(view.lastSyncAt).toLocaleTimeString() : "—"}
          />
        </dl>
        {lastError ? <p className="text-destructive mt-3 text-xs">{lastError}</p> : null}
      </CardContent>
    </Card>
  );
}

function ControlButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="border-input bg-background hover:bg-accent disabled:opacity-40 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none"
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}
