import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — API key self-service, proxied for `<ApiKeysCard/>`. All three gate at `viewer`
 * upstream: managing YOUR OWN credentials is not a privileged act on the org.
 *
 * - GET  `/v1/auth/api-keys`    → `{apiKeys}` — never carries the plaintext or the hash.
 * - POST `/v1/auth/api-keys`    → 201 `{apiKey, token}` — the ONLY time the plaintext exists.
 *   Re-auth gated (D-15.9-6), so a 401 here is NOT "log in again" — read its `reason`:
 *   `password_required` ⇒ prompt for the password and retry; `reauth_required` ⇒ SSO-only account,
 *   sign in again. Forwarding the status verbatim is what makes that distinction reachable.
 * - DELETE `/v1/auth/api-keys`  → `{revoked: n}` — the panic button. Deliberately NOT re-auth
 *   gated: revocation must never be harder than minting.
 *
 * NOTE this file sits under `/api/auth/`, which `middleware.ts` exempts from the session gate. That
 * is harmless here — every one of these is session-gated UPSTREAM and 401s without a cookie — but it
 * is why the two PUBLIC invite proxies live under the same prefix deliberately rather than by
 * accident.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyJson("/v1/auth/api-keys", { signal: req.signal });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/auth/api-keys", {
    method: "POST",
    body,
    contentType: "application/json",
    signal: req.signal,
  });
}

export async function DELETE(req: NextRequest) {
  return proxyJson("/v1/auth/api-keys", { method: "DELETE", signal: req.signal });
}
