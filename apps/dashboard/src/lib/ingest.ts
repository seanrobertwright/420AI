/**
 * Server-ONLY ingest access helpers (M9, D8; M12 12.3 login). Imported exclusively by Server
 * Components and Route Handlers (the snapshot/SSE proxies) — NEVER by a "use client" component.
 * The browser talks only to the same-origin proxy Route Handlers; those add the bearer on the
 * server→ingest hop.
 *
 * M12 12.3: the dashboard no longer holds ADMIN_TOKEN. The bearer is now the logged-in admin's
 * HMAC SESSION TOKEN, read from the httpOnly `ai_session` cookie (set by /api/auth/login). The
 * ingest hybrid gate accepts that session token. NEVER expose the token via a NEXT_PUBLIC_* var.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./session";

/** The ingest base URL (defaults to the local ingest port 8420 from .env.example). */
export function ingestUrl(): string {
  return process.env.INGEST_URL ?? "http://localhost:8420";
}

/**
 * The admin Authorization header for the server→ingest hop. Bearer = the logged-in admin's
 * session token from the httpOnly cookie (server-only; `cookies()` is async in Next 15/16).
 * Returns `{}` when no session cookie is present (the request 401s upstream → middleware login).
 */
export async function adminHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { authorization: "Bearer " + token } : {};
}
