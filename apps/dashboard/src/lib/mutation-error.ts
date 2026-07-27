/**
 * M15 15.4 — one place that turns a failed mutation response into a message a human can act on.
 *
 * The slice adds a THIRD failure mode to every mutation. Before it, a non-ok response meant
 * either "gone" (404) or "something broke" (5xx), and `failed (${res.status})` was an adequate
 * summary of both. A 403 is neither: the request was well-formed, the resource exists, and
 * retrying will never help — the account simply may not do this. Rendering that as
 * "Create failed (403)." reads as a transient error and invites exactly the retry that cannot
 * succeed.
 *
 * No proxy change is needed to get here: `proxy.ts` already forwards `res.status` verbatim
 * ("forward 400/401/404 so the UI can react"), so a 403 reaches the browser unchanged.
 *
 * CAVEAT worth knowing before raising any gate: `proxyStream`'s MONITOR path deliberately
 * collapses every upstream failure to 502 ("ingest down"). That is harmless today only because
 * `GET /v1/monitor/stream` gates at `viewer`, so it can never return 403. If a later slice
 * raises that gate, the dashboard would show "ingest down" for a permission refusal.
 *
 * Exported as CONSTANTS rather than a `mutationErrorMessage(status)` helper: every call site
 * already has its own 404 wording ("No longer pending.", "Project has no events to report on.")
 * that a generic formatter would flatten, so a helper would either be bypassed or would make the
 * messages worse. Only the 403 case is genuinely shared.
 */
/** The 403 wording, shared so every refusal in the UI reads the same. */
export const FORBIDDEN_MESSAGE = "You do not have permission to do this. Ask an admin for access.";

/** The compact form, for the inline status labels that render beside a row. */
export const FORBIDDEN_SHORT = "not permitted";
