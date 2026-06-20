# Feature: M12 Slice 12.3 — Auth Hardening (real single-user admin login)

The following plan should be complete, but it's important that you validate documentation and codebase
patterns and task sanity before you start implementing. Pay special attention to naming of existing
utils, types, and models. Import from the right files (relative imports end in `.js`; `import type`
for type-only). Project conventions are the source of truth — **read
[`CLAUDE.md`](../../CLAUDE.md)** (do not re-derive them here).

## Feature Description

Today the ingest API's admin surface is gated by a single **static shared secret** (`ADMIN_TOKEN`,
constant-time-compared in `adminAuthorized`), and the "current user" is a **hardcoded constant**
`DEFAULT_EMAIL = "seanrobertwright@gmail.com"` copy-pasted across 10 route files. The web dashboard
holds that same `ADMIN_TOKEN` in server env and adds it on every server→ingest hop — but **anyone who
can reach the dashboard URL drives that proxy** (there is no login).

This slice introduces a **real single-user admin login**: a password (scrypt-hashed, seeded from env),
a stateless **HMAC-signed session token** issued by `POST /v1/auth/login`, a Next.js **middleware login
gate** on the dashboard, and retirement of the hardcoded `DEFAULT_EMAIL` in favor of a configurable
`app.adminEmail`. The static `ADMIN_TOKEN` is **demoted to a machine/service token** (desktop M11 +
collector CLI keep using it unchanged — the **Hybrid** model: the ingest admin gate accepts *either* a
valid human session *or* the service token).

**No RBAC, no multi-user, no OAuth** — those are V2. (GitHub OAuth was considered and rejected for V1:
the product is local-first/offline and all repo reliance is *local git* filesystem reads, not the
GitHub API — there is zero Octokit/GitHub-API usage in the codebase, so a GitHub identity buys nothing
a `.git/config` read doesn't already provide, while adding an external dependency + per-install OAuth-app
registration friction. Revisit in V2 *if* a real GitHub API connector lands.)

## User Story

As the **self-hosting single admin** of my 420AI archive,
I want to **log into the dashboard with a real email + password** instead of relying on a static shared
token that anyone reaching the URL can use,
So that **only I can view/operate the archive**, my admin identity is a real DB user, and the static
admin token survives only as a machine-to-machine credential for my desktop app and CLI.

## Problem Statement

1. **No human authentication on the dashboard.** Anyone who can reach the dashboard origin can drive the
   server-side proxy with full admin authority — the only "auth" is network reachability.
2. **A single static shared secret is the entire admin boundary.** `ADMIN_TOKEN` is long-lived,
   un-rotatable without coordinated restarts, and identical for humans (dashboard) and machines
   (desktop/CLI). It cannot be tied to a person or expired per-session.
3. **`DEFAULT_EMAIL` is hardcoded in 10 route files.** The single-user identity is a literal string,
   not configuration — it can't be changed without editing source, and it duplicates a value that
   should have one home.

## Solution Statement

- **Password:** add a nullable `password_hash` column to `users`; hash with **scrypt** (`node:crypto`,
  no dependency). Seed the single admin from `ADMIN_EMAIL` + `ADMIN_PASSWORD` env on ingest boot.
- **Session:** `POST /v1/auth/login` verifies the password and returns a **stateless HMAC-SHA256-signed
  token** (`base64url(payload).base64url(mac)`, payload `{sub,iat,exp}`), signed with `SESSION_SECRET`
  (`node:crypto`). No session table.
- **Hybrid gate:** `adminAuthorized(app, request)` stays **sync, same call signature**; its body now
  returns true for a valid service token (`ADMIN_TOKEN`, unchanged path — desktop/CLI) **OR** a valid
  session token. The 12 admin routes don't change their call.
- **Retire `DEFAULT_EMAIL`:** decorate `app.adminEmail` (from `ADMIN_EMAIL`, defaulting to the legacy
  literal for back-compat) and replace the 10 hardcoded constants with `app.adminEmail`.
- **Dashboard login:** a `/login` page + `POST /api/auth/login` route handler that calls ingest and
  stores the token in an **httpOnly cookie**; a `middleware.ts` that **verifies the cookie via Edge
  `crypto.subtle`** (interop with the Node signer is spike-proven) and redirects to `/login` when
  missing/invalid/expired. `adminHeaders()` now forwards the **session token from the cookie** as the
  bearer (the dashboard no longer needs `ADMIN_TOKEN`).

## Feature Metadata

**Feature Type**: Enhancement (security hardening) + small New Capability (login surface)
**Estimated Complexity**: **High** (cross-cutting: db migration + ingest auth + dashboard middleware;
but each touch point is mechanical and the crypto is spike-proven)
**Primary Systems Affected**: `packages/db` (users schema + repo), `apps/ingest` (auth gate, new
`/v1/auth/*` routes, env seed, 10 `DEFAULT_EMAIL` sites), `apps/dashboard` (middleware, login page +
route handlers, `adminHeaders`, nav), `.env.example` + docs
**Dependencies**: **None new** — scrypt + HMAC are both in `node:crypto`; the dashboard verifier uses
the global `crypto.subtle` (Edge runtime). No npm packages added.

---

## CONTEXT REFERENCES

### Relevant Codebase Files — YOU MUST READ THESE BEFORE IMPLEMENTING

**Ingest auth (the heart of the change):**
- `apps/ingest/src/auth.ts` (whole file, 30 lines) — `adminAuthorized(app, request)` constant-time
  bearer compare + `isUuid`. **You extend `adminAuthorized` here.** Keep it sync.
- `apps/ingest/src/plugins/auth.ts` (lines 9–27) — the `declare module "fastify"` augmentation where
  `adminToken`/`catalogPublicKey`/etc. are typed on `FastifyInstance`. **Add `adminEmail` +
  `sessionSecret` here.** (The machine `authenticate` preHandler, lines 37–52, is **untouched**.)
- `apps/ingest/src/app.ts` (lines 27–63) — `BuildAppOptions` + `buildApp` `app.decorate(...)` calls.
  **Add `adminEmail?`/`sessionSecret?` options + decorations.** (Error handler lines 84–104 untouched —
  but see Task 9 for the `AuthError` note: we do NOT need one; routes send 401 directly.)
- `apps/ingest/src/server.ts` (whole file) — reads env, builds the app, listens. **Add `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`, `SESSION_SECRET` env reads + admin seeding + pass new opts to `buildApp`.**
- `apps/ingest/src/routes/pairing-codes.ts` (whole file, 42 lines) — **the exact pattern to MIRROR for a
  new route**: `export default async function xRoutes(app)`, `app.post<{Body}>(url, {schema}, handler)`,
  `if (!adminAuthorized(app, request)) return reply.code(401)...`, `reply.code(200).send(...)`. Note it
  uses `DEFAULT_EMAIL` at line 6/28 — one of the 10 sites to retire.
- `apps/ingest/src/schemas.ts` (lines 8–15 `pairingCodeBodySchema`) — the `as const` JSON-schema body
  pattern to MIRROR for `loginBodySchema`.
- `apps/ingest/src/routes/projects.ts` (lines 7–46) — a representative `DEFAULT_EMAIL` +
  `findUserIdByEmail`/`ensureUserByEmail` + `adminAuthorized` route to retire + verify against.

**The 10 `DEFAULT_EMAIL` sites to retire** (each has `const DEFAULT_EMAIL = "seanrobertwright@gmail.com";`
near the top + 1–4 usages — replace the const with `app.adminEmail` at the usage):
`apps/ingest/src/routes/{alerts.ts, exports.ts, git.ts, monitor.ts, interpretations.ts,
pairing-codes.ts, projections.ts, projects.ts, reports.ts, workspaces.ts}`.

**DB layer:**
- `packages/db/src/schema.ts` (lines 45–49 `users` table) — **add `passwordHash: text("password_hash")`
  (nullable).**
- `packages/db/src/repositories/users.ts` (whole file, 32 lines) — `findUserIdByEmail`,
  `ensureUserByEmail`. **Add `findAdminCredential` + `setUserPassword` here.**
- `packages/db/src/index.ts` (line 40) — the barrel `export { findUserIdByEmail, ensureUserByEmail }
  from "./repositories/users.js"`. **Add the two new fns.**
- `packages/db/drizzle/0004_bouncy_romulus.sql` — example generated migration format (you do NOT
  hand-write; `npm run db:generate` emits the new one — see Task 2 GOTCHA).
- `packages/db/drizzle.config.ts` — confirms `db:generate` reads `./src/schema.ts` → `./drizzle`.

**Dashboard:**
- `apps/dashboard/src/lib/ingest.ts` (whole file, 19 lines) — `ingestUrl()` + `adminHeaders()`.
  **`adminHeaders()` becomes `async` and reads the session cookie instead of `ADMIN_TOKEN`.**
- `apps/dashboard/src/lib/proxy.ts` (whole file) — `proxyJson`/`proxyStream` call `adminHeaders()`.
  **Add `await`.**
- `apps/dashboard/src/app/projects/page.tsx` (whole file, 21 lines) — representative **Server Component**
  that calls `adminHeaders()` directly in a server-side `fetch`. **Add `await`.** (13 call sites total —
  see Task 13.)
- `apps/dashboard/src/app/layout.tsx` + `apps/dashboard/src/components/app-nav.tsx` — where the nav
  renders; **add a logout control** (Task 17).
- `apps/dashboard/src/app/api/projects/route.ts` — representative Route Handler proxy (no change needed;
  it calls `proxyJson` which handles the header).

**Test harness to MIRROR:**
- `apps/ingest/src/app.int.test.ts` (lines 1–80) — the int-test scaffold: `TEST_URL`,
  `describe.skipIf(!TEST_URL)`, `createDb(TEST_URL!)`, `buildApp({...})`, `beforeEach TRUNCATE ...
  RESTART IDENTITY CASCADE`, `app.inject({method,url,headers:{authorization:'Bearer '+ADMIN}})`.
  **Your `auth.int.test.ts` mirrors this.**
- `apps/dashboard/src/lib/proxy.test.ts` / `apps/dashboard/src/lib/ingest.test.ts` — co-located dashboard
  unit-test patterns (vitest, run by the root `vitest run`).

### New Files to Create

- `apps/ingest/src/password.ts` — `hashPassword` / `verifyPassword` (scrypt, `node:crypto`).
- `apps/ingest/src/password.test.ts` — unit tests (round-trip, wrong password, malformed stored value).
- `apps/ingest/src/session.ts` — `signSession` / `verifySession` (HMAC-SHA256, `node:crypto`) +
  `SESSION_TTL_SECONDS`.
- `apps/ingest/src/session.test.ts` — unit tests (valid, tampered, wrong secret, expired).
- `apps/ingest/src/routes/auth.ts` — `POST /v1/auth/login` + `GET /v1/auth/me`.
- `apps/ingest/src/auth.int.test.ts` — login → token-as-bearer e2e (self-skips without `DATABASE_URL_TEST`).
- `apps/dashboard/src/lib/session.ts` — `verifySession` via `crypto.subtle` (Edge-compatible) + the
  cookie name constant.
- `apps/dashboard/src/lib/session.test.ts` — **interop test**: sign with `node:crypto`, verify with
  `subtle` (mirrors PRE-FLIGHT Spike 3).
- `apps/dashboard/src/middleware.ts` — the login gate.
- `apps/dashboard/src/app/login/page.tsx` — login form (client component).
- `apps/dashboard/src/app/api/auth/login/route.ts` — POST → ingest login → set httpOnly cookie.
- `apps/dashboard/src/app/api/auth/logout/route.ts` — clear cookie.
- `apps/dashboard/src/components/auth/login-form.tsx` — the `"use client"` form island (optional split;
  may inline into `login/page.tsx` if you prefer — but `page.tsx` should stay a Server Component shell).

### Relevant Documentation — READ THESE BEFORE IMPLEMENTING

- Node `crypto.scryptSync` — <https://nodejs.org/api/crypto.html#cryptoscryptsyncpassword-salt-keylen-options>
  - Why: password hashing without a dependency. Note default `N=16384` is fine; no `maxmem` tuning needed
    at `keylen ≤ 64`.
- Node `crypto.createHmac` + `timingSafeEqual` —
  <https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options>
  - Why: signing/verifying the session token in ingest (constant-time MAC compare).
- Web Crypto `SubtleCrypto.sign`/`importKey` (HMAC) —
  <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign>
  - Why: the dashboard middleware runs on the **Edge runtime** (no `node:crypto`); it verifies with
    `subtle`. PRE-FLIGHT Spike 3 proved Node-HMAC ≡ subtle-HMAC byte-for-byte.
- Next.js Middleware — <https://nextjs.org/docs/app/building-your-application/routing/middleware>
  - Why: the login gate. `request.cookies.get(name)` is **sync** in middleware; `NextResponse.redirect`.
- Next.js `cookies()` from `next/headers` —
  <https://nextjs.org/docs/app/api-reference/functions/cookies>
  - Why: **async** in Next 15/16 — `adminHeaders()` (reads the cookie) and the login/logout route
    handlers (set/clear the cookie) must `await cookies()`. **GOTCHA:** `cookies().set()` is only allowed
    in Route Handlers / Server Actions, **not** in Server Components — that's why login/logout are Route
    Handlers.

### Patterns to Follow

**New ingest route (MIRROR `routes/pairing-codes.ts`):**
```ts
import type { FastifyInstance } from "fastify";
import { findAdminCredential } from "@420ai/db";
import { loginBodySchema } from "../schemas.js";
import { verifyPassword } from "../password.js";
import { signSession, SESSION_TTL_SECONDS } from "../session.js";

interface LoginBody { email: string; password: string; }

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>("/v1/auth/login", { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const { email, password } = request.body;
      const cred = await findAdminCredential(app.db, email);
      // Generic 401 whether the user is missing or the password is wrong (no user-enumeration).
      if (!cred?.passwordHash || !verifyPassword(password, cred.passwordHash)) {
        return reply.code(401).send({ error: "invalid email or password" });
      }
      const { token, exp } = signSession(email, app.sessionSecret, SESSION_TTL_SECONDS);
      return reply.code(200).send({ token, expiresAt: new Date(exp * 1000).toISOString() });
    },
  );

  // GET /v1/auth/me — session-gated identity probe for the dashboard's logged-in state.
  app.get("/v1/auth/me", async (request, reply) => {
    if (!adminAuthorized(app, request)) {
      return reply.code(401).send({ error: "admin authorization required" });
    }
    return reply.code(200).send({ email: app.adminEmail });
  });
}
```
> Import `adminAuthorized` from `../auth.js` for `/me`. `signSession` returns `{ token, exp }` (exp in
> epoch-seconds). The body schema makes `email`+`password` required so a malformed body 400s before the
> handler (via `err.validation` in `app.ts`).

**Session token (ingest `session.ts`) — format proven by Spike 2:**
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload { sub: string; iat: number; exp: number; }

export function signSession(sub: string, secret: string, ttlSec: number):
    { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const body = Buffer.from(JSON.stringify({ sub, iat, exp })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return { token: `${body}.${mac}`, exp };
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
```
> **Spike-snippet fidelity (Spike 2 assertions):** valid token → payload; `token+"x"` (tampered) → null;
> wrong secret → null; `exp` in the past → null. Keep these as the `session.test.ts` cases.

**Password hashing (ingest `password.ts`) — proven by Spike 1:**
```ts
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```
> **Spike-snippet fidelity (Spike 1 assertions):** `verifyPassword(pw, hashPassword(pw)) === true`;
> wrong password → false; malformed `stored` → false (never throws).

**Extended hybrid gate (ingest `auth.ts`) — additive, stays sync:**
```ts
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifySession } from "./session.js";

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer (.+)$/.exec(header) : null;
  return match ? match[1]! : null;
}

/** True if the request carries the static service token (desktop/CLI) OR a valid admin session. */
export function adminAuthorized(app: FastifyInstance, request: FastifyRequest): boolean {
  const token = bearerToken(request);
  if (!token) return false;
  // (1) Service token — the unchanged ADMIN_TOKEN path (machine clients: desktop M11 + CLI).
  const presented = Buffer.from(token);
  const expected = Buffer.from(app.adminToken);
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) return true;
  // (2) Human session token (HMAC-signed by POST /v1/auth/login).
  return verifySession(token, app.sessionSecret) !== null;
}
```
> **GOTCHA:** evaluate the service-token compare with `timingSafeEqual` guarded by a length check
> (the original did this) — `timingSafeEqual` throws on length mismatch, so the `length ===` guard is
> mandatory, not optional. Order doesn't matter for correctness; service-token-first avoids an HMAC for
> machine clients.

**Dashboard `adminHeaders()` — now reads the session cookie (async):**
```ts
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./session";

export function ingestUrl(): string {
  return process.env.INGEST_URL ?? "http://localhost:8420";
}

/** Bearer = the logged-in admin's session token (httpOnly cookie). Server-only. */
export async function adminHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { authorization: "Bearer " + token } : {};
}
```
> **GOTCHA:** every caller of `adminHeaders()` must now `await` it (13 sites — Task 13). All are already
> inside `async` Server Components / Route Handlers, so adding `await` is safe and mechanical.

**Dashboard middleware (Edge `subtle` verify — interop proven by Spike 3):**
```ts
import { NextResponse, type NextRequest } from "next/server";
import { verifySessionEdge, SESSION_COOKIE } from "@/lib/session";

const PUBLIC = ["/login"]; // page paths that never require a session

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p) || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET ?? "";
  if (token && secret && (await verifySessionEdge(token, secret))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Gate everything except Next internals + static assets (and the public paths handled above).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
```
> `verifySessionEdge` lives in `lib/session.ts` and uses `crypto.subtle` (NOT `node:crypto` — unavailable
> on Edge). It must base64url-decode the MAC and `importKey`/`sign` then constant-compare, plus the same
> `exp` check as the Node verifier. **GOTCHA:** `request.cookies.get()` is sync in middleware;
> `cookies()` from `next/headers` (used elsewhere) is async — don't mix them up.

**Dashboard `lib/session.ts` (Edge verifier + cookie constant):**
```ts
export const SESSION_COOKIE = "ai_session";

export async function verifySessionEdge(
  token: string, secret: string,
): Promise<{ sub: string; exp: number } | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = b64url(new Uint8Array(sig));
  if (expected.length !== macB64.length) return null;
  let diff = 0; // constant-ish compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ macB64.charCodeAt(i);
  if (diff !== 0) return null;
  let payload: { sub: string; exp: number };
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
```
> Implement `b64url(bytes)` and `b64urlDecode(str)` as small helpers (the standard
> base64→base64url char swap `+/`→`-_` and `=` strip; `atob`/`btoa` exist on Edge). Keep them in this
> file. The `session.test.ts` interop test signs a token with `node:crypto` (as ingest does) and asserts
> `verifySessionEdge` returns the payload — and rejects a tampered token. This is the executable form of
> Spike 3.

**Login Route Handler (`app/api/auth/login/route.ts`) — sets the httpOnly cookie:**
```ts
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ingestUrl } from "@/lib/ingest";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text(); // {email,password} forwarded verbatim
  let res: Response;
  try {
    res = await fetch(`${ingestUrl()}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
  if (!res.ok) return new NextResponse(await res.text(), { status: res.status,
    headers: { "content-type": "application/json" } });
  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
  return NextResponse.json({ ok: true });
}
```
> Logout (`app/api/auth/logout/route.ts`) mirrors this: `(await cookies()).delete(SESSION_COOKIE)` then
> `NextResponse.json({ ok: true })` (POST).

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (DB + ingest crypto primitives)
Add the `password_hash` column + repo functions, and the two pure, unit-tested crypto modules
(`password.ts`, `session.ts`). Nothing wired yet — these are leaf modules with their own tests.

### Phase 2: Core Implementation (ingest auth surface)
Extend the Fastify type augmentation + `buildApp` options/decorations, the hybrid `adminAuthorized`
gate, the `/v1/auth/*` routes, the env-seed in `server.ts`, and retire the 10 `DEFAULT_EMAIL` sites.

### Phase 3: Integration (dashboard login gate)
Edge session verifier, middleware gate, login/logout route handlers + page, `adminHeaders()` →
session-cookie (and `await` at the 13 sites), nav logout control.

### Phase 4: Testing & Validation
Unit tests (password, session, dashboard interop), the ingest `auth.int.test.ts`, `.env.example` +
docs, and the full `repo-health --require-db` gate.

---

## STEP-BY-STEP TASKS

> Execute in order, top to bottom. Each task is atomic; run its VALIDATE before moving on.

### Task 1 — UPDATE `packages/db/src/schema.ts` (users.password_hash)
- **IMPLEMENT**: add `passwordHash: text("password_hash"),` to the `users` `pgTable` (nullable — no
  `.notNull()`; existing rows + the pairing-only flow keep working).
- **PATTERN**: `users` block lines 45–49; `text(...)` already imported (line 4).
- **GOTCHA**: nullable on purpose — a user created by the pairing flow (`ensureUserByEmail`) has no
  password; only the seeded admin gets one.
- **VALIDATE**: `npx tsc -b` (root) exits 0.

### Task 2 — GENERATE the migration
- **IMPLEMENT**: run `npm run db:generate` (drizzle-kit diffs `src/schema.ts` → emits
  `packages/db/drizzle/0009_<auto-name>.sql` + `meta/0009_snapshot.json` + updates `meta/_journal.json`).
- **PATTERN**: every prior migration was generated this way (see `0004_bouncy_romulus.sql`). **Do NOT
  hand-write the SQL.**
- **GOTCHA**: `db:generate` loads the repo-root `.env` (per `drizzle.config.ts`) for `DATABASE_URL` —
  it only needs the URL to *connect for introspection*; the diff is schema-driven. Expected emitted DDL:
  `ALTER TABLE "users" ADD COLUMN "password_hash" text;`. If the generator wants a name, accept the
  default. Commit all three emitted files.
- **VALIDATE**: `git status` shows exactly the new `0009_*.sql`, `meta/0009_snapshot.json`, and a
  modified `meta/_journal.json`; open the `.sql` and confirm it is the single additive `ADD COLUMN`.

### Task 3 — UPDATE `packages/db/src/repositories/users.ts` (+ barrel)
- **IMPLEMENT**: add two functions:
  - `findAdminCredential(db, email): Promise<{ id: string; email: string; passwordHash: string | null }
    | undefined>` — `select({id, email, passwordHash}).from(users).where(eq(users.email,email)).limit(1)`.
  - `setUserPassword(db, email, passwordHash: string): Promise<string>` — find-or-create by email AND set
    the hash, returning the id. MIRROR `ensureUserByEmail` (lines 25–32) but
    `.values({ email, passwordHash }).onConflictDoUpdate({ target: users.email, set: { passwordHash } })`.
- **IMPORTS**: `users` (already), `eq` (already).
- **UPDATE**: `packages/db/src/index.ts` line 40 — add `findAdminCredential, setUserPassword` to the
  existing `users.js` export.
- **GOTCHA**: select `passwordHash` explicitly (it's the new column); Drizzle maps `password_hash` →
  `passwordHash` via the schema field name.
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 4 — CREATE `apps/ingest/src/password.ts` (+ test)
- **IMPLEMENT**: `hashPassword` / `verifyPassword` exactly per the Patterns snippet (Spike 1).
- **CREATE** `apps/ingest/src/password.test.ts`: round-trip true; wrong password false; malformed stored
  (`"garbage"`, `"scrypt$x"`) → false (no throw).
- **VALIDATE**: `npx vitest run apps/ingest/src/password.test.ts` → all pass.

### Task 5 — CREATE `apps/ingest/src/session.ts` (+ test)
- **IMPLEMENT**: `SESSION_TTL_SECONDS`, `SessionPayload`, `signSession`, `verifySession` per the Patterns
  snippet (Spike 2).
- **CREATE** `apps/ingest/src/session.test.ts`: valid round-trip returns `{sub,iat,exp}`; tampered token
  → null; wrong secret → null; manually-crafted expired token (`exp` in the past, re-signed) → null.
- **GOTCHA**: to test expiry deterministically, sign with a tiny negative ttl
  (`signSession("a", s, -1)`) and assert `verifySession` → null.
- **VALIDATE**: `npx vitest run apps/ingest/src/session.test.ts` → all pass.

### Task 6 — UPDATE `apps/ingest/src/plugins/auth.ts` (type augmentation)
- **IMPLEMENT**: in the `declare module "fastify" { interface FastifyInstance { ... } }` block, add
  `adminEmail: string;` and `sessionSecret: string;` (next to `adminToken: string;`).
- **PATTERN**: lines 9–27.
- **VALIDATE**: `npx tsc -b` exits 0 (will still 0 — decorations come in Task 7).

### Task 7 — UPDATE `apps/ingest/src/app.ts` (options + decorations)
- **IMPLEMENT**: in `BuildAppOptions` add `adminEmail?: string;` and `sessionSecret?: string;` (both
  optional — see GOTCHA). In `buildApp`, after the `adminToken` decoration add:
  - `app.decorate("adminEmail", opts.adminEmail ?? "seanrobertwright@gmail.com");`
  - `app.decorate("sessionSecret", opts.sessionSecret ?? randomBytes(32).toString("base64url"));`
  - register `authRoutes` (Task 9) alongside the other `app.register(...)` calls.
- **IMPORTS**: `import { randomBytes } from "node:crypto";` and
  `import authRoutes from "./routes/auth.js";`.
- **GOTCHA (blast-radius control)**: keeping both options **optional with defaults** means the **6
  existing `buildApp` test callers** (`app.int.test.ts`, `catalog.int.test.ts`, `git.int.test.ts`,
  `exports.int.test.ts`, `apps/collector/{capture-engine,push}.int.test.ts`) **do NOT change** — they
  keep working, `adminEmail` defaults to the legacy literal (so every existing `DEFAULT_EMAIL`-seeded
  test still resolves the same user), and each gets an ephemeral per-process `sessionSecret`. Only
  `server.ts` (Task 10) passes real values. **Do not make these required.**
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 8 — UPDATE `apps/ingest/src/auth.ts` (hybrid gate)
- **IMPLEMENT**: replace `adminAuthorized` with the extended version per the Patterns snippet (service
  token OR `verifySession`). Keep `isUuid` unchanged. Add the `bearerToken` helper.
- **IMPORTS**: `import { verifySession } from "./session.js";` (keep `timingSafeEqual`).
- **GOTCHA**: preserve the length-guard before `timingSafeEqual` (throws on length mismatch).
- **VALIDATE**: `npx tsc -b` exits 0; existing `app.int.test.ts` admin routes still authorize with the
  service token (run in Task 19).

### Task 9 — CREATE `apps/ingest/src/routes/auth.ts` + UPDATE `schemas.ts`
- **IMPLEMENT**: `authRoutes` with `POST /v1/auth/login` and `GET /v1/auth/me` per the Patterns snippet.
- **ADD** to `apps/ingest/src/schemas.ts` (mirror `pairingCodeBodySchema`):
  ```ts
  export const loginBodySchema = {
    type: "object", required: ["email", "password"], additionalProperties: false,
    properties: { email: { type: "string", minLength: 1 }, password: { type: "string", minLength: 1 } },
  } as const;
  ```
- **IMPORTS**: `findAdminCredential` from `@420ai/db`; `verifyPassword` from `../password.js`;
  `signSession`, `SESSION_TTL_SECONDS` from `../session.js`; `adminAuthorized` from `../auth.js`;
  `loginBodySchema` from `../schemas.js`.
- **GOTCHA**: login is intentionally **un-gated** (it's the entry point). Generic 401 on bad
  user-or-password (no enumeration). Brute-force rate-limiting is **explicitly deferred to 12.4** (ops
  baseline) — note this in a code comment; scrypt cost + localhost single-user makes it acceptable now.
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 10 — UPDATE `apps/ingest/src/server.ts` (env reads + seed)
- **IMPLEMENT**:
  - read `const adminEmail = process.env.ADMIN_EMAIL ?? "seanrobertwright@gmail.com";`,
    `const sessionSecret = process.env.SESSION_SECRET;`, `const adminPassword = process.env.ADMIN_PASSWORD;`.
  - `if (!sessionSecret) throw new Error("SESSION_SECRET is not set (copy .env.example to .env)");`
    (mirror the existing `ADMIN_TOKEN` guard at line 13).
  - **after** `createDb`: if `adminPassword` is set, seed the admin —
    `await setUserPassword(db, adminEmail, hashPassword(adminPassword));` (idempotent; updates the hash on
    every boot so rotating `ADMIN_PASSWORD` + restart re-seeds). If unset, log nothing (library/entrypoint
    rule: server.ts is the entrypoint and MAY log — a one-line `console.warn` that login is disabled until
    `ADMIN_PASSWORD` is set is acceptable here).
  - pass `adminEmail, sessionSecret` into the existing `buildApp({...})` call.
- **IMPORTS**: `setUserPassword` from `@420ai/db`; `hashPassword` from `./password.js`.
- **GOTCHA**: seed **after** `createDb` and **before** `app.listen`. `setUserPassword` is async — the
  file is already top-level `await` (line 60 `await app.listen`), so `await` here is fine.
- **VALIDATE**: `npx tsc -b` exits 0.

### Task 11 — RETIRE `DEFAULT_EMAIL` across the 10 route files
- **IMPLEMENT**: in each of `apps/ingest/src/routes/{alerts,exports,git,monitor,interpretations,
  pairing-codes,projections,projects,reports,workspaces}.ts`: delete the
  `const DEFAULT_EMAIL = "seanrobertwright@gmail.com";` line and replace each usage `..., DEFAULT_EMAIL)`
  with `..., app.adminEmail)`. (`app` is in scope in every handler — these are
  `export default async function xRoutes(app) { app.<verb>(..., async (request,reply) => { ... }) }`.)
- **PATTERN**: `routes/projects.ts:13,33,46` and `routes/pairing-codes.ts:6,28`.
- **GOTCHA**: `pairing-codes.ts` uses `DEFAULT_EMAIL` inside an inline `users` upsert (line 28) — replace
  with `app.adminEmail` there too. Some files use it 1×, others up to 4× (`git.ts` 4×, `reports.ts` 3×) —
  grep each file for `DEFAULT_EMAIL` and replace **all** occurrences, then delete the const.
- **VALIDATE**: `rg "DEFAULT_EMAIL" apps/ingest/src` returns **zero** matches; `npx tsc -b` exits 0.

### Task 12 — CREATE `apps/dashboard/src/lib/session.ts` (Edge verifier + cookie name)
- **IMPLEMENT**: `SESSION_COOKIE = "ai_session"` + `verifySessionEdge` per the Patterns snippet, with the
  `b64url`/`b64urlDecode` helpers (use `btoa`/`atob`, available on Edge + Node ≥ 24).
- **VALIDATE**: `npm run typecheck:dashboard` exits 0.

### Task 13 — UPDATE `apps/dashboard/src/lib/ingest.ts` + the 13 `adminHeaders()` callers
- **IMPLEMENT**: change `adminHeaders()` to the async cookie-reading version per the Patterns snippet
  (import `cookies` from `next/headers`, `SESSION_COOKIE` from `./session`). Keep `ingestUrl()`.
- **UPDATE** every caller to `await adminHeaders()`. The 13 files:
  `lib/proxy.ts` (2 calls: `proxyJson`, `proxyStream`), and the Server Components
  `app/{settings,machines,catalog,reports,projects,monitor}/page.tsx`, `app/projects/[id]/page.tsx`,
  and the Route Handlers `app/api/monitor/route.ts`, `app/api/monitor/stream/route.ts`,
  `app/api/alerts/firings/[id]/ack/route.ts`. (Also update `lib/ingest.test.ts` — Task 18.)
- **PATTERN**: `app/projects/page.tsx:13` (`headers: adminHeaders()` → `headers: await adminHeaders()`).
- **GOTCHA**: `proxyStream` builds `headers: adminHeaders()` inline in a `fetch` options object — change
  to `const headers = await adminHeaders();` first, then use it (you can't `await` inside an object
  literal cleanly alongside other awaited members). Verify each call site is inside an `async` fn (all
  are).
- **VALIDATE**: `rg "adminHeaders\(\)" apps/dashboard/src` shows every occurrence prefixed with `await`
  (except the definition); `npm run typecheck:dashboard` exits 0.

### Task 14 — CREATE `apps/dashboard/src/middleware.ts`
- **IMPLEMENT**: the login gate per the Patterns snippet.
- **GOTCHA**: the `matcher` must exclude `_next/*` and static assets, and the body must early-return for
  `/login` + `/api/auth/*`. `SESSION_SECRET` must be present in the **dashboard** env (Task 16 / docs).
  If `SESSION_SECRET` is unset, the gate redirects everything to `/login` (fail-closed) — acceptable.
- **VALIDATE**: `npm run typecheck:dashboard` exits 0; `npm run build:dashboard` succeeds (Next compiles
  middleware for the Edge runtime — this is where an accidental `node:crypto` import in the middleware
  import-graph would fail the build; keep middleware → `lib/session.ts` (subtle only)).

### Task 15 — CREATE the login/logout route handlers + login page
- **IMPLEMENT**:
  - `app/api/auth/login/route.ts` — per the Patterns snippet (forward to ingest; set httpOnly cookie).
  - `app/api/auth/logout/route.ts` — `export async function POST()` → `(await cookies()).delete(SESSION_COOKIE)`
    → `NextResponse.json({ ok: true })`. `export const dynamic = "force-dynamic";`.
  - `app/login/page.tsx` — a Server Component shell rendering a `"use client"` `LoginForm`
    (`components/auth/login-form.tsx`) that POSTs `{email,password}` JSON to `/api/auth/login`; on
    `res.ok` `router.push(searchParams.get("next") ?? "/monitor")` (use `useRouter`/`useSearchParams`);
    on 401 show "invalid email or password"; on 502 show "archive unreachable". Style with the existing
    shadcn primitives (`components/ui/card.tsx`, plain inputs/buttons — MIRROR the visual density of
    `components/projects/project-create.tsx` for form styling).
- **GOTCHA**: the login page must NOT be gated (it's in the middleware `PUBLIC` list). The form is a
  client island; the page file stays a Server Component (so `metadata`/layout compose normally).
- **VALIDATE**: `npm run typecheck:dashboard` exits 0; `npm run build:dashboard` succeeds.

### Task 16 — UPDATE `apps/dashboard/src/components/app-nav.tsx` (logout)
- **IMPLEMENT**: add a right-aligned **Logout** control: a tiny `"use client"` action (the nav is already
  a client component) that `fetch("/api/auth/logout", { method: "POST" })` then
  `window.location.href = "/login"`. Optionally fetch `/api/auth/me` via a `/api/auth/me` proxy to show
  the admin email — **optional**; keep minimal (a logout button is sufficient).
- **GOTCHA**: don't add `/login` to the nav `LINKS`. The nav still renders on `/login`? It renders via the
  root layout on every route — acceptable, but the **logout** button on the login page is harmless. (If
  you want to hide the nav on `/login`, branch on `usePathname() === "/login"` and return `null` — nice
  to have, not required.)
- **VALIDATE**: `npm run typecheck:dashboard` + `npm run build:dashboard` succeed.

### Task 17 — CREATE `apps/dashboard/src/lib/session.test.ts` (interop, mirrors Spike 3)
- **IMPLEMENT**: sign a token with `node:crypto` (replicate `signSession` inline — same format) and
  assert `await verifySessionEdge(token, secret)` returns `{sub,exp}`; assert a tampered token → null;
  assert wrong secret → null. This is the executable proof that the ingest Node signer and the dashboard
  Edge verifier agree (Spike 3).
- **PATTERN**: co-located vitest like `lib/proxy.test.ts`. `crypto.subtle` + `createHmac` both exist in
  the vitest/node test env.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/session.test.ts` → all pass.

### Task 18 — UPDATE `apps/dashboard/src/lib/ingest.test.ts`
- **IMPLEMENT**: the existing test asserts `adminHeaders()` returns `{authorization: "Bearer <ADMIN_TOKEN>"}`
  from env. Rewrite to the new contract: with no session cookie → `{}`; with a cookie present →
  `{authorization: "Bearer <token>"}`. Mock `next/headers` `cookies()` (vitest `vi.mock("next/headers", …)`
  returning `{ get: () => ({ value: "tok" }) }`). Keep the `ingestUrl()` default-port assertion.
- **GOTCHA**: `adminHeaders()` is now async — `await` it in the test.
- **VALIDATE**: `npx vitest run apps/dashboard/src/lib/ingest.test.ts` → all pass.

### Task 19 — CREATE `apps/ingest/src/auth.int.test.ts`
- **IMPLEMENT**: mirror `app.int.test.ts` scaffold. `beforeAll`: `buildApp({ db, adminToken: "svc-token",
  adminEmail: "admin@test.local", sessionSecret: "test-secret", analysisProvider: stubProvider,
  logger: false })`. `beforeEach`: TRUNCATE (include `users`). Seed admin:
  `await setUserPassword(dbh.db, "admin@test.local", hashPassword("correct-horse"));`. Cases:
  1. `POST /v1/auth/login {email:"admin@test.local", password:"correct-horse"}` → 200, body has
     `token` (string) + `expiresAt` (ISO).
  2. wrong password → 401; unknown email → 401 (same message).
  3. use the returned `token` as `Authorization: Bearer <token>` on `GET /v1/projects` → 200
     (`{projects: []}`) — proves the session path of the hybrid gate.
  4. the **service token** `Bearer svc-token` on `GET /v1/projects` → 200 — proves the service path
     still works (desktop/CLI).
  5. no Authorization header on `GET /v1/projects` → 401.
  6. a forged token (`"a.b"`) on `GET /v1/projects` → 401.
  7. `GET /v1/auth/me` with the session token → 200 `{email:"admin@test.local"}`; without → 401.
- **GOTCHA**: this test **adds a `buildApp` caller with explicit `sessionSecret`** — that's deliberate
  (it needs a fixed secret to reason about tokens); it does NOT change the other 6 callers.
- **VALIDATE**: with the test DB up: `npx vitest run apps/ingest/src/auth.int.test.ts` → all pass,
  **0 skipped**.

### Task 20 — UPDATE `.env.example` + docs
- **IMPLEMENT**: in `.env.example`:
  - Reframe the `ADMIN_TOKEN` comment (lines 16–19): it is now the **machine/service token** for the
    desktop app + collector CLI (no longer a human credential).
  - Add an **Admin login (M12 12.3)** block: `ADMIN_EMAIL=` (defaults to the legacy address if unset),
    `ADMIN_PASSWORD=` (seeded → scrypt-hashed on ingest boot; rotate by changing this + restart),
    `SESSION_SECRET=` (HMAC signing key; generate with the same `randomBytes(32).toString("base64url")`
    one-liner). **SESSION_SECRET must be set identically for BOTH the ingest process AND the dashboard**
    (the dashboard middleware verifies with it) — call this out explicitly.
  - Update the dashboard block (lines 55–60): the dashboard no longer reads `ADMIN_TOKEN`; it needs
    `INGEST_URL` + `SESSION_SECRET`.
- **UPDATE** `README.md` onboarding (the M2 "Onboarding flow" + the M9 dashboard run note): the admin now
  **logs in** at `/login`; the dashboard run command no longer needs `ADMIN_TOKEN` (needs
  `SESSION_SECRET`). Keep it brief.
- **GOTCHA**: `docs/guide/install.md` / `usage.md` reference pairing-code curl with `$ADMIN_TOKEN` — those
  remain valid (service token still gates `/v1/pairing-codes`). No change required there, but a one-line
  note that the *dashboard* now uses a login is welcome.
- **VALIDATE**: `rg "REUSES ADMIN_TOKEN" .env.example` → 0 matches (the stale note is gone).

### Task 21 — Full gate
- **VALIDATE**: `npm run db:up && npm run db:migrate && npm run repo-health -- --require-db` → PASS with
  the int layer actually running (0 skipped). Then `npm run build:dashboard` → succeeds.

---

## TESTING STRATEGY

### Unit Tests
- `apps/ingest/src/password.test.ts` — scrypt round-trip / wrong / malformed (no-throw).
- `apps/ingest/src/session.test.ts` — HMAC valid / tampered / wrong-secret / expired.
- `apps/dashboard/src/lib/session.test.ts` — **Node-sign → Edge-verify interop** (the executable Spike 3)
  + tamper/wrong-secret rejection.
- `apps/dashboard/src/lib/ingest.test.ts` — `adminHeaders()` cookie-based contract (mocked `next/headers`).

### Integration Tests
- `apps/ingest/src/auth.int.test.ts` — the full login → session-bearer → admin-route path, plus the
  service-token path, plus 401s. Self-skips without `DATABASE_URL_TEST`; **must run 0-skipped under
  `--require-db`**.
- Existing `app.int.test.ts` / `catalog/git/exports.int.test.ts` — **must still pass unchanged** (proves
  the hybrid gate + `adminEmail` default preserved back-compat). This is the regression guard.

### Edge Cases (must be covered)
- Bad/expired/forged session token → ingest 401 AND dashboard middleware → redirect to `/login`.
- No `ADMIN_PASSWORD` set → login returns 401 for everyone (admin has no hash); the rest of the API still
  works via the service token (server boots, warns).
- Service token continues to authorize every admin route (desktop/CLI unbroken).
- `SESSION_SECRET` mismatch between ingest and dashboard → dashboard redirects to `/login` even with a
  freshly-issued cookie (documents why the secret must be shared) — covered conceptually; the interop
  unit test pins the same-secret success case.
- Login with malformed body (missing `password`) → 400 (Fastify `err.validation`).

---

## VALIDATION COMMANDS

All commands run from the repo root. **`repo-health` is the gate** (root `tsc -b` + full `vitest` +
NUL/stray scans).

### Level 1: Syntax & Style (repo-root typecheck — catches cross-project/test-only imports)
- `npm run typecheck` → exit 0 (root `tsc -b`, the 4 backend workspaces).
- `npm run typecheck:dashboard` → exit 0 (the dashboard's enforced lane; root `tsc -b` can't see it).

### Level 2: Unit Tests
- `npx vitest run apps/ingest/src/password.test.ts apps/ingest/src/session.test.ts
  apps/dashboard/src/lib/session.test.ts apps/dashboard/src/lib/ingest.test.ts` → all pass.

### Level 3: Integration Tests (DB up)
- `npm run db:up && npm run db:migrate`
- `npm run repo-health -- --require-db` → PASS, **0 int tests skipped** (asserts `auth.int.test.ts` and
  the existing int suites actually executed against Postgres).

### Level 4: Manual Validation (live stack)
1. Set `.env`: `ADMIN_EMAIL`, `ADMIN_PASSWORD=test-pass`, `SESSION_SECRET=<random>`, keep `ADMIN_TOKEN`.
   `npm run db:up && npm run db:migrate && npm run ingest:dev`.
2. `curl -s -X POST localhost:8420/v1/auth/login -H 'content-type: application/json'
   -d '{"email":"<ADMIN_EMAIL>","password":"test-pass"}'` → 200 `{token,expiresAt}`.
   Wrong password → 401.
3. `curl -s localhost:8420/v1/projects -H "authorization: Bearer <token-from-step-2>"` → 200
   `{"projects":[...]}`. With `Bearer $ADMIN_TOKEN` → also 200 (service path). With no header → 401.
4. Dashboard: `cd apps/dashboard` then `INGEST_URL=http://localhost:8420 SESSION_SECRET=<same-as-ingest>
   npx next dev` (note: **no `ADMIN_TOKEN`**). Open `http://localhost:3000/projects` →
   **redirected to `/login`**. Log in with the admin email/password → land on the requested page,
   data renders.
5. **D8 token-leak invariant (carry-over):** view page source on any authed page →
   `grep -c "$ADMIN_TOKEN"` on the served HTML **== 0** AND `grep -c "$SESSION_SECRET"` **== 0** (the
   session *token* may legitimately ride in an httpOnly cookie — assert the **secret** never appears).
   Use headless Edge per CLAUDE.md (the gstack daemon is unreliable on this machine).
6. Logout → redirected to `/login`; re-visiting `/projects` redirects to `/login`.

### Level 5: Build gate
- `npm run build:dashboard` → succeeds (compiles the Edge middleware; would fail if the middleware
  import-graph pulled in `node:crypto`).

---

## ACCEPTANCE CRITERIA

- [ ] `users.password_hash` column added via a **generated** `0009_*.sql` migration (+ snapshot + journal).
- [ ] `POST /v1/auth/login` issues an HMAC session token for the seeded admin; wrong/unknown creds → 401.
- [ ] The hybrid `adminAuthorized` accepts **either** a valid session token **or** the service token; the
      12 admin routes are unchanged at their call sites and still authorize.
- [ ] `DEFAULT_EMAIL` is **gone** from `apps/ingest/src` (`rg DEFAULT_EMAIL apps/ingest/src` == 0);
      identity resolves via `app.adminEmail` (configurable from `ADMIN_EMAIL`, legacy default preserved).
- [ ] The dashboard requires login: unauthenticated requests redirect to `/login`; the dashboard no
      longer reads `ADMIN_TOKEN` (uses the session cookie); `SESSION_SECRET` documented as shared.
- [ ] Desktop (M11) + collector CLI are **untouched** and still authorize with the service token.
- [ ] D8 invariant holds: `SESSION_SECRET` and `ADMIN_TOKEN` never appear in served HTML (grep == 0).
- [ ] `npm run repo-health -- --require-db` PASSES with **0 int tests skipped**; `build:dashboard` succeeds.
- [ ] No new npm dependency added (scrypt + HMAC from `node:crypto`; dashboard verify from `crypto.subtle`).

## COMPLETION CHECKLIST

- [ ] All 21 tasks completed in order; each task's VALIDATE passed immediately.
- [ ] Unit + integration suites green (int layer actually ran against Postgres).
- [ ] No typecheck errors (root `tsc -b` + dashboard lane); `build:dashboard` green.
- [ ] Manual login flow + D8 grep verified on the live stack (screenshots to `.agents/qa/m12-slice3/`).
- [ ] `.env.example` + README updated; `SUMMARY.md` 12.3 marked done at sign-off.
- [ ] Reviewed for the M9 long-lived-resource discipline (middleware/edge has no timers; the login
      route's `fetch` is request-scoped — no leak window introduced).

---

## NOTES

### Design decisions (and why)
- **Hybrid gate, not full replacement.** The single static token is *demoted*, not deleted: humans get
  real sessions; machines (desktop M11 + CLI) keep the service token. This honors "retire static
  ADMIN_TOKEN" on the human/dashboard path (the dashboard stops holding it) while keeping M11/CLI working
  with **zero Rust/CLI changes** this slice. Full machine-client migration is a later, optional step.
- **Single-user collapses authn ↔ identity.** A valid session *is* the one admin, so the gate only proves
  "signed + unexpired" and identity stays `app.adminEmail`. This is what keeps `adminAuthorized` sync and
  same-signature — the 12 routes don't change. (Multi-user/RBAC is V2 and is where per-session identity
  would thread through.)
- **Stateless HMAC over a sessions table.** No revocation table needed for one user; "revoke all" = rotate
  `SESSION_SECRET`. Keeps the migration to a single additive column.
- **scrypt + HMAC from `node:crypto`; subtle on the Edge.** Zero new dependencies (mirrors M10
  catalog-signing's `node:crypto` ed25519 precedent) — important because native crypto deps would
  complicate the `node:sea` desktop sidecar build.
- **GitHub OAuth rejected for V1** (see Feature Description) — local-first/offline + zero GitHub-API usage;
  revisit in V2 if a real GitHub connector lands.
- **Optional `buildApp` options with defaults** deliberately keep the 6 existing test callers unchanged —
  the smallest possible blast radius on the proven harness.

### PRE-FLIGHT SPIKES ACTUALLY RUN DURING PLANNING (results folded in above)
All three executed via a throwaway `node` script (Node ≥ 24), output captured, script deleted:
- **Spike 1 — scrypt:** `verifyPassword("hunter2", hashPassword("hunter2")) === true`; wrong password
  `=== false`. ⇒ password module API confirmed (`password.ts` snippet is the proven code).
- **Spike 2 — HMAC session token:** valid token → `{sub,exp}`; `token+"x"` (tampered) → `null`; wrong
  secret → `null`; past-`exp` → `null`. ⇒ `session.ts` snippet is the proven code.
- **Spike 3 — Node↔Edge interop (THE load-bearing one):** `createHmac("sha256",secret).update(body)
  .digest("base64url")` === `base64url(subtle.sign("HMAC", importKey(secret,SHA-256), body))` —
  **byte-identical**. ⇒ an ingest-signed (Node) token verifies in Next middleware (Edge `subtle`); no JWT
  lib, no Node-runtime-middleware, no per-page 401 handling. `session.test.ts` (Task 17) is this spike as
  a permanent regression test.

### Symbols verified by reading source (not memory)
`adminAuthorized`/`isUuid` (`auth.ts`), the `declare module "fastify"` augmentation (`plugins/auth.ts`),
`BuildAppOptions`/`buildApp`/`app.decorate` (`app.ts`), `server.ts` env+listen shape, `findUserIdByEmail`/
`ensureUserByEmail` + the `users` schema (`repositories/users.ts`, `schema.ts:45-49`), the `@420ai/db`
barrel (`index.ts:40`), `adminHeaders`/`ingestUrl` (`lib/ingest.ts`) + all **13** call sites, `proxyJson`/
`proxyStream` (`lib/proxy.ts`), a Server-Component fetch (`projects/page.tsx`), the nav (`app-nav.tsx`),
the int-test harness (`app.int.test.ts:1-80`), the migration format (`0004_*.sql`) + `drizzle.config.ts`,
all **10** `DEFAULT_EMAIL` sites, all **12** `adminAuthorized` sites, all **7** `buildApp` callers, and the
absence of any existing `apps/dashboard/src/middleware.ts`.

### Residual risk (small; below-floor items retired)
- The dashboard **build** is the only place an accidental `node:crypto` import into the Edge middleware
  graph would surface — Task 14/15 VALIDATE runs `build:dashboard` precisely to catch it. `lib/session.ts`
  is `subtle`-only by construction.
- `cookies()` async-vs-`request.cookies` sync is the one easy-to-trip Next API distinction — called out in
  Task 13/14 GOTCHAs.
