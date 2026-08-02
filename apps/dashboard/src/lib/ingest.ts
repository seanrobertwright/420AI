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

/**
 * GET ingest JSON on the server→ingest hop (D8), returning `null` on any non-200 or throw.
 *
 * SERVER-ONLY, like everything else in this file — it calls `adminHeaders()`, which reads the
 * httpOnly session cookie. Never import it from a `"use client"` component.
 *
 * Extracted in M15 15.10 because a third byte-identical copy was about to appear (`/team` joining
 * `/settings`). The drift that matters is not the ten lines — it is the COMBINATION: `adminHeaders()`
 * for the bearer, `cache: "no-store"` so Next's data cache never serves a stale roster, and the
 * swallow-to-null that every caller's `?? fallback` depends on. A copy that silently omitted
 * `no-store` would serve stale tenant data with no error anywhere.
 *
 * `app/projects/[id]/page.tsx` keeps its own variant deliberately: it returns a typed FALLBACK
 * rather than null, so it is a different contract, not a fourth copy of this one.
 */
export async function getIngestJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
