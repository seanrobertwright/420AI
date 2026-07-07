import type { ReparseResult } from "./repositories/reparse.js";

/**
 * The outcome of a re-parse run, decoupled from process/IO so the entrypoint
 * stays a thin shell (CLAUDE.md: only entrypoints log/exit). Mirrors
 * `reprice-run.ts` — but unlike re-pricing, re-parse has NO refusal state: an
 * active catalog is optional (present → the upsert re-prices under it; absent →
 * costs re-derive from the built-in catalog exactly as at capture time).
 */
export interface ReparseOutcome {
  exitCode: number;
  message: string;
}

/**
 * Run a re-parse and phrase its outcome. Injectable deps (DI testing style,
 * mirrors `runReprice`), so it unit-tests with no DB.
 */
export async function runReparse<A>(deps: {
  getActive: () => Promise<A | null | undefined>;
  reparse: (repricing: A | undefined) => Promise<ReparseResult>;
}): Promise<ReparseOutcome> {
  const active = (await deps.getActive()) ?? undefined;
  const r = await deps.reparse(active);
  const skippedNote =
    r.skipped.gemini > 0 || r.skipped.other > 0
      ? ` (skipped ${r.skipped.gemini} gemini + ${r.skipped.other} other sessions — not re-parseable)`
      : "";
  const priceNote = active ? ", re-priced under the active catalog" : "";
  return {
    exitCode: 0,
    message: `re-parsed ${r.sessions} sessions: ${r.eventsUpserted} events upserted, ${r.orphansDeleted} orphaned events deleted${priceNote}${skippedNote}`,
  };
}
