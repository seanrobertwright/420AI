/**
 * Server-ONLY ingest access helpers (M9, D8). Imported exclusively by Server Components
 * and Route Handlers (the snapshot/SSE proxies) — NEVER by a "use client" component — so
 * the admin token is only ever read on the server and is never bundled into browser JS.
 * The browser talks only to the same-origin proxy Route Handlers (/api/monitor,
 * /api/monitor/stream); those add the bearer on the server→ingest hop. NEVER expose
 * ADMIN_TOKEN via a NEXT_PUBLIC_* var.
 */

/** The ingest base URL (defaults to the local ingest port 8420 from .env.example). */
export function ingestUrl(): string {
  return process.env.INGEST_URL ?? "http://localhost:8420";
}

/** The admin Authorization header for the server→ingest hop (token from server env only). */
export function adminHeaders(): Record<string, string> {
  const token = process.env.ADMIN_TOKEN;
  return token ? { authorization: "Bearer " + token } : {};
}
