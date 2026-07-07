/**
 * EDGE-runtime session verifier (M12 12.3). The Next middleware runs on the Edge runtime,
 * which has NO `node:crypto` — so this verifies the ingest-signed HMAC token with the global
 * `crypto.subtle` instead. The byte format is interop-proven against ingest's node:crypto
 * signer (see apps/dashboard/src/lib/session.test.ts and apps/ingest/src/session.ts):
 * `base64url(payload).base64url(mac)`, mac = HMAC-SHA256(secret, payloadBase64url).
 *
 * Keep this file `subtle`-only by construction — an accidental `node:crypto` import here would
 * break `next build` (the Edge middleware import-graph), which is exactly what the build gate catches.
 */

export const SESSION_COOKIE = "ai_session";

/**
 * Returns an actionable error message when the dashboard's session secret is missing, else null.
 *
 * The dashboard verifies the ingest-signed cookie's HMAC with SESSION_SECRET. If it is unset (e.g.
 * absent from `apps/dashboard/.env.local`, which Next loads from the dashboard CWD — NOT the repo
 * root), the middleware's `secret` is "" and EVERY navigation fails the verify gate, so a fresh login
 * silently bounces back to /login even though `/api/auth/login` returned 200 (the D.3 bug). The login
 * route + middleware call this to fail LOUDLY instead of degrading silently — mirroring how the ingest
 * server refuses to boot without SESSION_SECRET.
 */
export function sessionConfigError(): string | null {
  return (process.env.SESSION_SECRET ?? "") === ""
    ? "Dashboard is misconfigured: SESSION_SECRET is not set. Add it to apps/dashboard/.env.local with the SAME value as the ingest server's .env, then restart the dashboard."
    : null;
}

/** Bytes → base64url (standard base64 with +/ → -_ and `=` padding stripped). */
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → bytes (reverse of b64url; re-pads before atob). */
function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Verify a session token's HMAC + expiry on the Edge runtime. Returns the payload, or null
 * for any failure (malformed, tampered, wrong secret, expired). Mirrors ingest's verifySession.
 */
export async function verifySessionEdge(
  token: string,
  secret: string,
): Promise<{ sub: string; exp: number } | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = b64url(new Uint8Array(sig));
  if (expected.length !== macB64.length) return null;
  // Constant-ish compare (length already equal): XOR every char, never short-circuit.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ macB64.charCodeAt(i);
  if (diff !== 0) return null;
  let payload: { sub: string; exp: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  // Guard before property access — JSON.parse can yield null (MAC-gated, but stay defensive).
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}
