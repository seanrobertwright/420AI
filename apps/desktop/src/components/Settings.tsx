import { useEffect, useState, type ReactNode } from "react";
import {
  getServerConfig,
  setServerConfig,
  startArchive,
  stopArchive,
  startIngest,
  stopIngest,
  getServerHealth,
  unpair,
  getPairingStatus,
  type ServerConfigView,
  type ServerConfigInput,
  type ServerHealth,
  type PairingStatus,
} from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const DEFAULT_INGEST_URL = "http://localhost:8420";
const KEPT_SECRET = "•••• set — leave blank to keep";

/** Archive compose-state → badge color (mirrors SyncHealth's STATUS_BADGE palette). */
function archiveBadgeClass(state: string): string {
  switch (state) {
    case "healthy":
      return "border-transparent bg-emerald-500/15 text-emerald-400";
    case "running":
    case "starting":
      return "border-transparent bg-amber-500/15 text-amber-400";
    case "stopped":
      return "border-transparent bg-muted text-muted-foreground";
    default:
      return "border-transparent bg-destructive/15 text-destructive";
  }
}

/**
 * Settings + full server-stack supervision (M11 Slice 4). Three sections:
 *  (a) server CONFIG — `serverDir`/`ingestUrl` + the secrets (admin token, DB URL,
 *      encryption key, optional ANALYSIS_*). Secrets are write-only: their values are
 *      NEVER read back (the masked view carries only presence booleans), and a blank
 *      secret field on Save means "keep the stored value";
 *  (b) server STACK — Start/Stop the Docker archive + the ingest process, and a health
 *      probe (archive compose state + ingest `/v1/health`); and
 *  (c) PAIRING — the read-only paired machine + an Unpair button (clears the keychain
 *      pairing entry).
 *
 * Like Pairing.tsx this talks to Rust `#[command]`s (not the sidecar event stream), so
 * it needs NO `onControlEvent` subscription. Every `invoke` goes through `run()` so a
 * rejection ("Docker not installed/not running", "ingest not built — run npm run build",
 * "node not on PATH", "server not configured") becomes a visible panel line.
 */
export function Settings() {
  const [config, setConfig] = useState<ServerConfigView | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);

  // Form fields (controlled). Secrets start blank; the placeholder reflects presence.
  const [serverDir, setServerDir] = useState("");
  const [ingestUrl, setIngestUrl] = useState(DEFAULT_INGEST_URL);
  const [ingestPort, setIngestPort] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [archiveEncryptionKey, setArchiveEncryptionKey] = useState("");
  const [analysisProvider, setAnalysisProvider] = useState("");
  const [analysisApiKey, setAnalysisApiKey] = useState("");
  const [analysisModel, setAnalysisModel] = useState("");
  const [analysisBaseUrl, setAnalysisBaseUrl] = useState("");

  const [saving, setSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Wrap an invoke so a rejection surfaces as panel state (Pairing.tsx pattern).
  // Use `runOk` instead when you need a success boolean — e.g. for void invokes where
  // `undefined` on success is indistinguishable from the failure path.
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(String(err));
      return undefined;
    }
  };

  // Wrap a VOID-returning invoke, returning whether it succeeded (a void invoke can't
  // signal success via its resolved value — see `run`).
  const runOk = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  };

  // Seed the non-secret form fields from the masked view (secrets stay blank — their
  // values are never sent back from Rust).
  const seedForm = (cfg: ServerConfigView): void => {
    setServerDir(cfg.serverDir);
    setIngestUrl(cfg.ingestUrl || DEFAULT_INGEST_URL);
    setIngestPort(cfg.ingestPort != null ? String(cfg.ingestPort) : "");
    setAnalysisProvider(cfg.analysisProvider ?? "");
    setAnalysisModel(cfg.analysisModel ?? "");
    setAnalysisBaseUrl(cfg.analysisBaseUrl ?? "");
  };

  const refreshHealth = (): void => {
    setHealthLoading(true);
    getServerHealth()
      .then((h) => setHealth(h))
      .catch((err) => setError(String(err)))
      .finally(() => setHealthLoading(false));
  };

  // On mount: load config + health + pairing state. `disposed` guards a late resolve
  // after unmount (no listener to tear down — pure command calls).
  useEffect(() => {
    let disposed = false;

    getServerConfig()
      .then((cfg) => {
        if (disposed) return;
        setConfig(cfg);
        if (cfg) seedForm(cfg);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    getServerHealth()
      .then((h) => {
        if (!disposed) setHealth(h);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    getPairingStatus()
      .then((s) => {
        if (!disposed) setPairingStatus(s);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });

    return () => {
      disposed = true;
    };
  }, []);

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSavedNote(null);
    const portTrim = ingestPort.trim();
    const port = portTrim === "" ? undefined : Number(portTrim);
    if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
      setError("Ingest port must be a positive integer");
      setSaving(false);
      return;
    }
    // Omit a blank secret so Rust keeps the stored value; send non-secret fields as-is
    // (an empty string clears an optional ANALYSIS_* field).
    const input: ServerConfigInput = {
      serverDir: serverDir.trim(),
      ingestUrl: ingestUrl.trim(),
      ...(port !== undefined ? { ingestPort: port } : {}),
      ...(adminToken.trim() !== "" ? { adminToken: adminToken.trim() } : {}),
      ...(databaseUrl.trim() !== "" ? { databaseUrl: databaseUrl.trim() } : {}),
      ...(archiveEncryptionKey.trim() !== ""
        ? { archiveEncryptionKey: archiveEncryptionKey.trim() }
        : {}),
      ...(analysisApiKey.trim() !== "" ? { analysisApiKey: analysisApiKey.trim() } : {}),
      analysisProvider,
      analysisModel,
      analysisBaseUrl,
    };
    const ok = await runOk(() => setServerConfig(input));
    if (ok) {
      // Re-read the masked view so the presence placeholders update; clear the secret
      // inputs (they've been stored — never hold them locally).
      const cfg = await run(() => getServerConfig());
      if (cfg) {
        setConfig(cfg);
        seedForm(cfg);
      }
      setAdminToken("");
      setDatabaseUrl("");
      setArchiveEncryptionKey("");
      setAnalysisApiKey("");
      setSavedNote("Saved to the keychain.");
    }
    setSaving(false);
  };

  const onArchive = async (action: () => Promise<void>): Promise<void> => {
    setArchiveBusy(true);
    await run(action);
    setArchiveBusy(false);
    refreshHealth();
  };

  const onIngest = async (action: () => Promise<void>): Promise<void> => {
    setIngestBusy(true);
    await run(action);
    setIngestBusy(false);
    refreshHealth();
  };

  const onUnpair = async (): Promise<void> => {
    setUnpairing(true);
    if (await runOk(() => unpair())) setPairingStatus({ paired: false, machineId: null });
    setUnpairing(false);
  };

  const paired = pairingStatus?.paired ?? false;
  const secretPlaceholder = (present: boolean | undefined, hint: string): string =>
    present ? KEPT_SECRET : hint;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          server config (secrets stored in the OS keychain) · start/stop the archive &amp; ingest ·
          pairing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* (a) Server config form */}
        <section className="space-y-4">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Server config
          </p>
          <div className="grid gap-3">
            <Field label="Server directory (repo root)">
              <input
                type="text"
                value={serverDir}
                onChange={(e) => setServerDir(e.target.value)}
                placeholder={"C:\\path\\to\\420AI"}
                className={inputClass}
              />
            </Field>
            <Field label="Ingest URL">
              <input
                type="text"
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
                placeholder={DEFAULT_INGEST_URL}
                className={inputClass}
              />
            </Field>
            <Field label="Ingest port (optional)">
              <input
                type="text"
                inputMode="numeric"
                value={ingestPort}
                onChange={(e) => setIngestPort(e.target.value)}
                placeholder="8420"
                className={inputClass}
              />
            </Field>
            <Field label="Admin token">
              <input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder={secretPlaceholder(
                  config?.hasAdminToken,
                  "admin bearer for /v1/monitor",
                )}
                className={cn(inputClass, "font-mono")}
              />
            </Field>
            <Field label="Database URL">
              <input
                type="password"
                value={databaseUrl}
                onChange={(e) => setDatabaseUrl(e.target.value)}
                placeholder={secretPlaceholder(
                  config?.hasDatabaseUrl,
                  "postgres://420ai:420ai@localhost:5433/420ai",
                )}
                className={cn(inputClass, "font-mono")}
              />
            </Field>
            <Field label="Archive encryption key">
              <input
                type="password"
                value={archiveEncryptionKey}
                onChange={(e) => setArchiveEncryptionKey(e.target.value)}
                placeholder={secretPlaceholder(
                  config?.hasArchiveEncryptionKey,
                  "32-byte base64 (PRD §18.1)",
                )}
                className={cn(inputClass, "font-mono")}
              />
            </Field>
          </div>

          {/* Optional analysis provider (M8) */}
          <details className="border-border rounded-md border px-3 py-2">
            <summary className="text-muted-foreground cursor-pointer text-xs uppercase tracking-wide">
              Analysis provider (optional)
            </summary>
            <div className="mt-3 grid gap-3">
              <Field label="Analysis provider">
                <input
                  type="text"
                  value={analysisProvider}
                  onChange={(e) => setAnalysisProvider(e.target.value)}
                  placeholder="anthropic | openai"
                  className={inputClass}
                />
              </Field>
              <Field label="Analysis API key">
                <input
                  type="password"
                  value={analysisApiKey}
                  onChange={(e) => setAnalysisApiKey(e.target.value)}
                  placeholder={secretPlaceholder(config?.hasAnalysisApiKey, "provider API key")}
                  className={cn(inputClass, "font-mono")}
                />
              </Field>
              <Field label="Analysis model">
                <input
                  type="text"
                  value={analysisModel}
                  onChange={(e) => setAnalysisModel(e.target.value)}
                  placeholder="claude-sonnet-4-6"
                  className={inputClass}
                />
              </Field>
              <Field label="Analysis base URL">
                <input
                  type="text"
                  value={analysisBaseUrl}
                  onChange={(e) => setAnalysisBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1 (OpenAI-compatible only)"
                  className={inputClass}
                />
              </Field>
            </div>
          </details>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={saving || serverDir.trim() === "" || ingestUrl.trim() === ""}
              className="border-transparent bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors disabled:pointer-events-none"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {savedNote ? <p className="text-muted-foreground text-xs">{savedNote}</p> : null}
          </div>
        </section>

        {/* (b) Server stack controls + health */}
        <section className="border-border space-y-4 border-t pt-6">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Server stack
            </p>
            <button
              type="button"
              onClick={refreshHealth}
              disabled={healthLoading}
              className="border-input bg-background hover:bg-accent disabled:opacity-40 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none"
            >
              {healthLoading ? "Refreshing…" : "Refresh health"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Archive</span>
              <Badge className={cn(archiveBadgeClass(health?.archive ?? "unknown"))}>
                {health?.archive ?? "unknown"}
              </Badge>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Ingest</span>
              <Badge
                className={cn(
                  health?.ingest
                    ? "border-transparent bg-emerald-500/15 text-emerald-400"
                    : "border-transparent bg-muted text-muted-foreground",
                )}
              >
                {health?.ingest ? "up" : "down"}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <StackButton onClick={() => onArchive(startArchive)} disabled={archiveBusy}>
              {archiveBusy ? "Archive…" : "Start Archive"}
            </StackButton>
            <StackButton onClick={() => onArchive(stopArchive)} disabled={archiveBusy}>
              Stop Archive
            </StackButton>
            <StackButton onClick={() => onIngest(startIngest)} disabled={ingestBusy}>
              {ingestBusy ? "Ingest…" : "Start Ingest"}
            </StackButton>
            <StackButton onClick={() => onIngest(stopIngest)} disabled={ingestBusy}>
              Stop Ingest
            </StackButton>
          </div>
        </section>

        {/* (c) Pairing */}
        <section className="border-border space-y-3 border-t pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                Pairing{" "}
                <Badge variant={paired ? "default" : "outline"}>
                  {paired ? "paired" : "not paired"}
                </Badge>
              </p>
              <p className="text-muted-foreground text-xs">
                {paired && pairingStatus?.machineId
                  ? `paired as ${pairingStatus.machineId}`
                  : "Not connected to an archive — pair from the Pairing panel."}
              </p>
            </div>
            <button
              type="button"
              onClick={onUnpair}
              disabled={unpairing || !paired}
              className="border-input bg-background hover:bg-accent disabled:opacity-40 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none"
            >
              {unpairing ? "Unpairing…" : "Unpair"}
            </button>
          </div>
        </section>

        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

const inputClass =
  "border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-1";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function StackButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-input bg-background hover:bg-accent disabled:opacity-40 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}
