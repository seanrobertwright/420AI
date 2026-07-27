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
 */
/** The 403 wording, shared so every refusal in the UI reads the same. */
export const FORBIDDEN_MESSAGE = "You do not have permission to do this. Ask an admin for access.";

/** The compact form, for the inline status labels that render beside a row. */
export const FORBIDDEN_SHORT = "not permitted";

export function mutationErrorMessage(status: number, action = "Action"): string {
  if (status === 403) {
    return FORBIDDEN_MESSAGE;
  }
  if (status === 401) {
    return "Your session has expired. Sign in again.";
  }
  if (status === 404) {
    return "No longer available.";
  }
  return `${action} failed (${status}).`;
}
