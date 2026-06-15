import { StatusBar } from "@/components/StatusBar";
import { SyncHealth } from "@/components/SyncHealth";
import { Connectors } from "@/components/Connectors";

/**
 * The desktop webview shell (M11). Slice 1 shipped the StatusBar; Slice 2 adds the
 * Sync & Health (local backlog + server fleet view/alerts) and Connectors (per-source
 * enable/disable + fidelity/permission-scope review) panels. Later slices add Pairing
 * and Settings. The tray (Rust) and this webview are two views over the same
 * Rust↔sidecar relay.
 */
export function App() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">420AI Collector</h1>
        <p className="text-muted-foreground text-sm">
          Local capture agent — drive it here or from the tray.
        </p>
      </header>
      <div className="space-y-6">
        <StatusBar />
        <SyncHealth />
        <Connectors />
      </div>
    </main>
  );
}
