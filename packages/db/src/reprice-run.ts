import type { RepriceResult } from "./repositories/reprice.js";

/**
 * F.5 — the outcome of a re-pricing run, decoupled from process/IO so the entrypoint stays a thin
 * shell (CLAUDE.md: only entrypoints log/exit). `exitCode` is non-zero for a refusal so scripts can
 * branch, but the refusal is a CLEAN message — NOT a thrown stack trace (the bug was `reprice-cli`
 * throwing `no active catalog`, which Node printed as an uncaught stack + exit 1).
 */
export interface RepriceOutcome {
  exitCode: number;
  message: string;
}

/**
 * Decide a re-pricing run's outcome. No active catalog is an EXPECTED state (like a 409), not an
 * error: return a clean refusal the caller prints to stderr and exits non-zero on — never throw.
 * Generic over the catalog shape + injectable deps (DI testing style, mirrors `syncOnce({ post })`),
 * so it unit-tests with no DB.
 */
export async function runReprice<A>(deps: {
  getActive: () => Promise<A | null | undefined>;
  reprice: (active: A) => Promise<RepriceResult>;
}): Promise<RepriceOutcome> {
  const active = await deps.getActive();
  if (!active) {
    return {
      exitCode: 1,
      message: "No active pricing catalog to re-price under — approve one first.",
    };
  }
  const { repriced, catalogVersion } = await deps.reprice(active);
  return { exitCode: 0, message: `re-priced ${repriced} events under catalog ${catalogVersion}` };
}
