import { useEffect, useState, type ReactNode } from "react";
import {
  pair,
  getPairingStatus,
  getAutostart,
  setAutostart,
  type PairingStatus,
} from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const DEFAULT_URL = "http://localhost:8420";

/**
 * GUI pairing + run-on-login (M11 Slice 3). The form POSTs the archive URL + pairing
 * code + machine name to the Rust `pair` `#[command]`, which does the HTTP handshake,
 * stores the issued token in the OS keychain, and `configure`s the sidecar. The token
 * is born in Rust and NEVER reaches this panel — only the `machineId` comes back (the
 * paired state carries no secret).
 *
 * Unlike the StatusBar/Connectors panels this talks to Rust `#[command]`s (not the
 * sidecar event stream), so it needs NO `onControlEvent` subscription/teardown. Every
 * `invoke` still goes through `run()` so a rejection (e.g. "pairing failed: HTTP 410"
 * for an expired code) becomes panel state, not an unhandled promise rejection.
 */
export function Pairing() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wrap an arbitrary invoke so a rejection surfaces as panel state. A successful run
  // clears the prior error (mirrors StatusBar's `run()` helper, adapted to a thunk).
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(String(err));
      return undefined;
    }
  };

  // On mount, seed the paired state + autostart toggle. The `disposed` flag prevents a
  // setState after unmount if a slow invoke resolves late (no listener to tear down).
  useEffect(() => {
    let disposed = false;

    getPairingStatus()
      .then((s) => {
        if (!disposed) setStatus(s);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    getAutostart()
      .then((enabled) => {
        if (!disposed) setAutostartState(enabled);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });

    return () => {
      disposed = true;
    };
  }, []);

  const onPair = async (): Promise<void> => {
    setPairing(true);
    const result = await run(() => pair(url.trim(), code.trim(), name.trim()));
    if (result) {
      // Token is never returned — only the machineId. Reflect the new paired state and
      // clear the one-time code (it's spent).
      setStatus({ paired: true, machineId: result.machineId });
      setCode("");
    }
    setPairing(false);
  };

  const onToggleAutostart = async (): Promise<void> => {
    const next = !(autostart ?? false);
    await run(() => setAutostart(next));
    // Re-read the source of truth rather than assuming the write took.
    const enabled = await run(() => getAutostart());
    if (enabled !== undefined) setAutostartState(enabled);
  };

  const paired = status?.paired ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Pairing
              <Badge variant={paired ? "default" : "outline"}>
                {paired ? "paired" : "not paired"}
              </Badge>
            </CardTitle>
            <CardDescription>
              {paired && status?.machineId
                ? `paired as ${status.machineId}`
                : "Connect this collector to an archive — the token is stored in the OS keychain."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3">
          <Field label="Archive URL">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_URL}
              className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-1"
            />
          </Field>
          <Field label="Pairing code">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste the one-time code from the dashboard"
              className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-1"
            />
          </Field>
          <Field label="Machine name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="defaults to this computer's name"
              className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-1"
            />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPair}
            disabled={pairing || code.trim() === "" || url.trim() === ""}
            className="border-transparent bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors disabled:pointer-events-none"
          >
            {pairing ? "Pairing…" : paired ? "Re-pair" : "Pair"}
          </button>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>

        {/* Run-on-login toggle (autostart). */}
        <div className="border-border flex items-center justify-between border-t pt-4">
          <div>
            <p className="text-sm font-medium">Run on login</p>
            <p className="text-muted-foreground text-xs">
              Launch the collector automatically when you sign in.
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleAutostart}
            disabled={autostart === null}
            aria-pressed={autostart ?? false}
            className={cn(
              "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none",
              autostart
                ? "border-transparent bg-primary text-primary-foreground hover:opacity-90"
                : "border-input bg-background hover:bg-accent",
            )}
          >
            {autostart === null ? "…" : autostart ? "On" : "Off"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}
