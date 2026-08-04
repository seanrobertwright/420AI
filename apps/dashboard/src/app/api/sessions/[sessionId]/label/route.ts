import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M16 16.2 — one session's outcome label: read, create, edit, retract. All four hops forward the
 * upstream status VERBATIM (`proxyJson`'s contract), which is what lets the UI tell these apart:
 *
 *   - GET 404    — "no label yet". The EXPECTED answer on a session nobody has judged, not an
 *                  error, and the review surfaces render a "Label" button rather than a failure.
 *   - PATCH 403  — "not the author" (D-16.1-4). No rung overrides it: 16.4 reads these rows as
 *                  evidence and rewriting someone else's answer is falsification, not administration.
 *   - DELETE 404 — "not yours" for a non-author, deliberately NOT 403, so a colleague's judgement is
 *                  not disclosed by the refusal itself. An `admin` may force one (retraction is not
 *                  rewriting).
 *   - PATCH 400  — a partial patch of §4.3 fields against a SKIPPED row. Upgrading a skip needs
 *                  `status: "labeled"` plus the full judgement; a silent no-op would pollute the row.
 *
 * Collapsing any of those to a generic "failed" message throws away the only information the user
 * needs to act, so the islands must not.
 *
 * `params` is a PROMISE in this Next version — `await` it. `sessionId` is a CONNECTOR-SUPPLIED
 * string rather than a uuid, so it is `encodeURIComponent`'d into the upstream path: it may legally
 * contain characters that are not path-safe, and the existence guard upstream is `sessionDetail`,
 * not a format check.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/label`, { signal: req.signal });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.text();
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/label`, {
    method: "POST",
    body,
    contentType: "application/json",
    signal: req.signal,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.text();
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/label`, {
    method: "PATCH",
    body,
    contentType: "application/json",
    signal: req.signal,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return proxyJson(`/v1/sessions/${encodeURIComponent(sessionId)}/label`, {
    method: "DELETE",
    signal: req.signal,
  });
}
