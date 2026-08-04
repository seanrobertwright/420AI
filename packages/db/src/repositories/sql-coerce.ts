/**
 * Timestamp coercion helpers for repository reads (M16 16.3, PR #77 review).
 *
 * ONE DEFINITION, BECAUSE THIS IS THE REPO'S MOST-REPEATED BUG, NOT ITS MOST-REPEATED HELPER.
 * `toIso` had been copy-pasted byte-identically into four repository files, each with its own
 * comment explaining that it mirrors another copy. That is a smell in ordinary code and a hazard
 * here specifically, because CLAUDE.md names the ABSENCE of this normalization as a recurring
 * shipped defect (the M5 `projectEventSummary.lastActivity` bug, then M9 `activeSessions`, then a
 * third live instance found by 16.3's own spike S2). A helper that must be re-derived at each new
 * aggregate read is one the next reader will simply forget.
 *
 * THE MECHANISM, STATED ONCE SO IT IS NOT RE-DERIVED WRONG:
 *
 *   - `events.ts` is declared `mode:"string"`. Inside a raw `sql` template — `max(ts)`, `min(ts)`,
 *     `date_trunc(...)` — the column's parser does NOT apply, so the value arrives as Postgres text
 *     (`2026-08-01 00:00:00+00`): space-separated, no `T`, no `Z`. Not ISO.
 *   - A BARE `events.ts` selection is not ISO either, which is the part that keeps getting written
 *     down wrongly. node-postgres returns a JS `Date` for timestamptz (drizzle's node-postgres
 *     driver installs no `setTypeParser` override), and `PgTimestampString.mapFromDriverValue`
 *     formats it back to Postgres style — measured: `2026-08-01T00:00:00.000Z` comes back as
 *     `"2026-08-01 00:00:00.000-04"`, stamped with the SERVER's local offset.
 *   - A PLAIN timestamptz column (no `mode`) is a different mechanism again: the driver `Date`
 *     reaches you untouched, so `.toISOString()` is the fix and `toIso` is not what you want.
 *
 * So: if the wire contract says ISO, normalize. The aggregate case is the loudest instance of the
 * hazard, never the only one.
 */

/** Postgres timestamp text → strict ISO, or null. For `mode:"string"` reads (aggregate or bare). */
export const toIso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
