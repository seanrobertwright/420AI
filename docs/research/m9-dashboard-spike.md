# M9 — Live Monitor: Dashboard Integration Spike

**Status:** throwaway spike, run in an isolated git worktree.
**Date:** 2026-06-14
**Goal:** prove/disprove the M9 integration assumptions (Next.js dashboard in the npm
workspace, theGridCN, Fastify SSE, server-side proxy auth) with exact, paste-ready
configs and version pins.

Environment: Windows 11, Git Bash, **Node v24.16.0**, **npm 11.13.0**, **TypeScript 6.0.3**.
All `npm install`/`npx` ran inside the sandbox with **no** sandbox-disable needed
(network was available).

---

## 1. Summary table

| # | Task | Result | One-line evidence |
|---|------|--------|-------------------|
| 0 | Baseline `tsc -b` on the committed tree | **FAIL (pre-existing)** | Committed M8 `apps/ingest/src/analysis/provider.test.ts` fails root typecheck: `'maxOutputTokens' does not exist in type 'AnalysisProviderConfig'` (×2). Fixed in this spike by adding `maxOutputTokens?: number` to the config interface. |
| 1 | Scaffold `apps/dashboard` as workspace member | **PASS** | Hand-written Next 16 app; `npm install` from root resolved 34 added pkgs, **no peer-dep errors**. |
| 2 | `tsc -b` / repo-health coexistence | **PASS** | Dashboard kept OUT of the root `tsc -b` reference graph; root `tsc -b` exits 0, `repo-health` = PASS, **zero changes to `repo-health.mjs` or root `tsconfig.json`**. |
| 3 | Import shared types across the boundary | **PASS** | `import type { ConnectorHealthRow } from "@420ai/shared"` typechecks under the dashboard lane and compiles under `next build`. |
| 4 | theGridCN + shadcn | **PARTIAL** | shadcn init + `card` + theGridCN `@thegridcn/data-card` all work and build. `@thegridcn/hud` is **broken as shipped** (barrel re-exports 5 siblings the registry does not install). |
| 5 | Fastify SSE feasibility + deterministic test | **PASS** | Both `inject()` (bounded) and `listen({port:0})`+`fetch` ReadableStream recipes pass (2/2 tests). |
| 6 | Next server-side proxy auth | **PASS** | Route Handler reads `ADMIN_TOKEN` from `process.env`, sends `Authorization: Bearer …`; runtime test returned `sawAuth: "Bearer secret-xyz"`, HTTP 200, **0** token occurrences in browser HTML. |

**Final gate state with the dashboard present:**
`npm run typecheck` → **0 errors**. `npm run repo-health` → **PASS** (186 tests passed,
including 2 new SSE tests; 65 self-skipped int tests as expected without a DB).
`npm run build -w @420ai/dashboard` → **success**.

---

## 2. Version pins that worked

| Package | Pin |
|---|---|
| `next` | **16.2.9** (Turbopack build) |
| `react` / `react-dom` | **19.2.7** |
| `tailwindcss` | **4.3.1** |
| `@tailwindcss/postcss` | **4.3.1** |
| `shadcn` (CLI) | **4.11.0** |
| `lucide-react` | 1.18.0 (pulled by shadcn nova preset) |
| `radix-ui` | 1.5.0 (pulled by shadcn) |
| `fastify` (existing, ingest) | **5.8.5** — SSE pattern proven against this |

---

## 3. GO / NO-GO per assumption

- **A Next app can live in this npm workspace** → **GO.** It installs cleanly and does
  not disturb the existing workspaces.
- **`tsc -b` and `next build` coexist** → **GO**, by keeping the dashboard out of the
  root reference graph and giving it its own `tsc --noEmit` lane (exactly mirroring how
  `*.int.test.ts` are excluded). No `repo-health.mjs` change required.
- **repo-health stays green with a Next app** → **GO.** `.next/`, `out/`, `*.tsbuildinfo`
  are **already** in the root `.gitignore`; `next-env.d.ts` lives at the app root (not
  under `src/`) and is gitignored. The stray-artifact scan only walks `<pkg>/src` and
  only matches emitted `.js/.cjs/.mjs/.map/.d.ts`; the dashboard `src/` holds only
  `.ts/.tsx/.css`, so it is unaffected.
- **Shared types import across the boundary** → **GO.**
- **Fastify SSE** → **GO** (both deterministic test recipes work).
- **Server-side proxy auth (token never in browser)** → **GO.**
- **theGridCN** → **CONDITIONAL GO** — see §9. Adopt for self-contained 2D components
  (`data-card`); **do not** rely on barrel components like `hud`.

---

## 4. Paste-ready configs

### 4.1 `apps/dashboard/package.json`
```json
{
  "name": "@420ai/dashboard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@420ai/shared": "*",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.18.0",
    "next": "16.2.9",
    "radix-ui": "^1.5.0",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "shadcn": "^4.11.0",
    "tailwind-merge": "^3.6.0",
    "tw-animate-css": "^1.4.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.1",
    "@types/node": "^24",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4.3.1",
    "typescript": "^6"
  }
}
```
> `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `shadcn`,
> `radix-ui`, `lucide-react` are added by `shadcn init` (nova preset). Pin `next`,
> `react`, `react-dom` exactly (no caret) so the whole team builds the same toolchain.

### 4.2 `apps/dashboard/tsconfig.json` (standalone — does NOT extend the root base)
```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["dom", "dom.iterable", "ES2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",            // next build rewrites "preserve" -> "react-jsx"; ship it pre-set
    "strict": true,
    "noEmit": true,
    "incremental": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowJs": true,
    "verbatimModuleSyntax": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts"     // next build adds this automatically; ship it pre-set
  ],
  "exclude": ["node_modules"]
}
```
> Critical: this tsconfig is **NOT referenced** by the root `tsconfig.json`. It uses
> `moduleResolution: bundler` + `jsx`, which are incompatible with the root's
> `NodeNext`/`composite` graph. The dashboard typechecks via its own `npm run
> typecheck -w @420ai/dashboard` lane.

### 4.3 `apps/dashboard/next.config.ts`
```ts
import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // npm workspaces hoist node_modules to the repo root, so Turbopack's root must sit
  // at/above it or Next can't resolve `next` from app subdirs. Also silences the
  // "inferred workspace root / multiple lockfiles" warning.
  turbopack: {
    root: path.join(import.meta.dirname, "..", ".."),
  },
  // Compile @420ai/shared from the workspace source directly so the dashboard build
  // never depends on `tsc -b` having produced packages/shared/dist first.
  transpilePackages: ["@420ai/shared"],
  reactStrictMode: true,
};

export default nextConfig;
```

### 4.4 `apps/dashboard/postcss.config.mjs`
```js
const config = {
  plugins: ["@tailwindcss/postcss"],
};
export default config;
```

### 4.5 `apps/dashboard/src/app/globals.css` (Tailwind 4 entry, shadcn-extended)
```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
/* shadcn init then appends @theme inline + :root/.dark CSS-variable blocks */
```

### 4.6 `apps/dashboard/components.json` (with theGridCN registry)
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {
    "@thegridcn": "https://thegridcn.com/r/{name}.json"
  }
}
```

### 4.7 `.gitignore` additions
**Root `.gitignore` already covers everything Next emits** — `.next/`, `out/`,
`*.tsbuildinfo` are present. No root change is strictly required. Add a dashboard-local
`apps/dashboard/.gitignore` for clarity/safety:
```gitignore
# Next.js
/.next/
/out/
next-env.d.ts

# Vercel
.vercel

# Env
.env*.local
```

### 4.8 Root `tsconfig.json` / `repo-health.mjs` / root `package.json`
**No changes required to any of these for coexistence.** The dashboard is deliberately
absent from the root reference graph; `repo-health.mjs`'s scans tolerate the Next app
unchanged. (Optional convenience: add a root script
`"typecheck:dashboard": "npm run typecheck -w @420ai/dashboard"` and call it in CI so the
dashboard's own lane is enforced — the root `tsc -b` will NEVER catch dashboard type
errors.)

---

## 5. Shared-type import across the workspace boundary (Task 3 detail)

- `@420ai/shared` is a workspace **symlink** in `node_modules`; its `package.json`
  `exports["."]` points at `./dist/index.{js,d.ts}` (a *built* artifact).
- Under the dashboard's `moduleResolution: bundler`, both `tsc --noEmit` and `next build`
  resolved the import **even with `packages/shared/dist` deleted** — bundler resolution
  is more forgiving than NodeNext here. **Do not rely on that.** The robust fix is
  `transpilePackages: ["@420ai/shared"]` (in `next.config.ts` above), which makes Next
  compile the package's TS source directly and **decouples the dashboard build from
  `tsc -b` ordering**.
- No mismatch around the `.js` specifiers: shared's source uses NodeNext `.js`
  re-exports, and esbuild/Turbopack resolve those automatically (same as vitest does via
  its `@420ai/shared -> src/index.ts` alias).
- Use **`import type`** (the repo convention + `verbatimModuleSyntax` is on in the
  dashboard tsconfig too).

Proof file `apps/dashboard/src/app/page.tsx`:
```tsx
import type { ConnectorHealthRow } from "@420ai/shared";
const sample: ConnectorHealthRow[] = [{
  sourceConnector: "claude-code",
  lastEventAt: new Date().toISOString(),
  eventCount: 42, toolsFailed: 1,
  parserVersions: ["1.0.0"], models: ["claude-sonnet-4-6"],
}];
```

---

## 6. Fastify SSE — handler pattern + test recipe (Task 5)

Probe: `apps/ingest/src/spike/sse-probe.ts`. Test: `apps/ingest/src/spike/sse-probe.test.ts`
(2/2 pass in ~1s; picked up by the root vitest `apps/**/*.test.ts` include).

### Handler pattern (Fastify 5)
```ts
app.get("/sse", (request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  reply.hijack();                 // take over the socket; Fastify won't serialize a body

  let timer: NodeJS.Timeout | undefined;
  // LOAD-BEARING: stop pushing the instant the client disconnects.
  request.raw.on("close", () => { if (timer) clearInterval(timer); });

  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  timer = setInterval(() => send({ t: Date.now() }), 1000);
  // (a bounded probe clears the timer and calls reply.raw.end() after N events)
});
```
Key points: `reply.hijack()` is required so Fastify does not also try to send a reply;
write each event as `data: <payload>\n\n`; detect disconnect with
`request.raw.on("close", …)` to clear the interval.

### Test recipe A — `inject()` (deterministic, no socket; for BOUNDED streams)
```ts
const res = await app.inject({ method: "GET", url: "/sse" });
expect(res.headers["content-type"]).toBe("text/event-stream");
const events = res.payload.split("\n\n")
  .filter((b) => b.startsWith("data: "))
  .map((b) => JSON.parse(b.slice(6)));
expect(events).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
```
`inject()` buffers the whole response, so it only terminates if the handler calls
`reply.raw.end()` — perfect for a fixed-count probe; **not** for an infinite stream.

### Test recipe B — `listen({port:0})` + `fetch` ReadableStream (real socket)
```ts
const address = await app.listen({ port: 0, host: "127.0.0.1" });
const res = await fetch(`${address}/sse`);
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
// parse buf the same way; afterEach(() => app.close())
```
Use B to assert true streaming over a real port (and, with an `intervalMs`, timed
delivery). Both passed.

---

## 7. Next.js server-side proxy auth (Task 6)

Route Handler `apps/dashboard/src/app/api/health/route.ts`:
```ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";            // never statically prerender
const INGEST_URL = process.env.INGEST_URL ?? "http://localhost:3000";

export async function GET() {
  const token = process.env.ADMIN_TOKEN ?? "";     // server-only; never shipped to client
  let res: Response;
  try {
    res = await fetch(`${INGEST_URL}/v1/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "upstream ingest unreachable" }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "upstream ingest error", status: res.status }, { status: 502 });
  }
  return NextResponse.json(await res.json());
}
```
Runtime proof (against a stub upstream echoing the auth header):
```
$ curl http://127.0.0.1:3100/api/health
{"status":"ok","sawAuth":"Bearer secret-xyz"}   HTTP 200
# token occurrences in browser homepage HTML: 0
```
Gotchas proven:
- **`export const dynamic = "force-dynamic"`** is required, else Next may try to
  statically evaluate the handler at build time.
- **Wrap `fetch` in try/catch.** A connection refusal *throws* (it does not return
  `!res.ok`); without the catch the client gets an opaque 500 instead of a clean 502.
- Only Route Handlers / Server Components read `process.env.ADMIN_TOKEN`. Never expose it
  via a `NEXT_PUBLIC_*` var.

---

## 8. Pre-existing baseline bug found (must be fixed before M9)

The committed tree (`a7f3633`, M8) does **NOT** pass `npm run typecheck`. Root `tsc -b`
includes `apps/ingest` test files, and:
```
apps/ingest/src/analysis/provider.test.ts(15,3): error TS2353:
  Object literal may only specify known properties, and 'maxOutputTokens'
  does not exist in type 'AnalysisProviderConfig'.
apps/ingest/src/analysis/provider.test.ts(24,3): error TS2353: (same)
```
The test passes `maxOutputTokens` to `AnalysisProviderConfig`, but the interface in
`apps/ingest/src/analysis/provider.ts` never declared it. **Fix applied in this spike:**
add `maxOutputTokens?: number;` to `AnalysisProviderConfig`. (This is unrelated to M9 but
blocks any green gate; surface it to whoever owns M8. It implies `repo-health` was last
run green only via `--fast`/a stale build, or the hook's typecheck was bypassed.)

---

## 9. theGridCN verdict

**ADOPT selectively; plan a plain-shadcn fallback (PRD §9).**

What was tested (CLI `shadcn@4.11.0`, registry `@thegridcn` →
`https://thegridcn.com/r/{name}.json`):

| Command | Result |
|---|---|
| `npx shadcn@latest init --template next --preset nova --css-variables --yes` | OK (neutral base, CSS vars). **Note:** 4.x dropped `--base-color`; base color comes from the preset. Presets: nova/vega/maia/lyra/mira/luma/sera/rhea. |
| `npx shadcn@latest add card --yes` (plain) | OK → `src/components/ui/card.tsx` |
| `npx shadcn@latest add @thegridcn/data-card --yes` | OK → `src/components/data-card.tsx`, **self-contained, no 3D deps, builds** |
| `npx shadcn@latest add @thegridcn/hud --yes` | **Installs but is BROKEN** |

`@thegridcn/hud` is a **barrel** that does
`export { Reticle } from "./reticle"` … for 5 siblings (`reticle`, `hud-frame`, `stat`,
`speed-indicator`, `regen-indicator`) that **the registry does not install**. `next build`
then fails:
```
./src/components/hud.tsx:4:25
Type error: Cannot find module './reticle' or its corresponding type declarations.
```
The siblings **are** individually addressable (`npx shadcn add @thegridcn/reticle` etc.
succeed), so the barrel just omits its registry `dependencies`.

**Recommendation for M9:** use theGridCN for self-contained 2D widgets like `data-card`
(verified to build). For `hud`-style composites, either add the leaf components
explicitly or fall back to composing plain shadcn primitives. No theGridCN 3D/Three.js
components were tested (out of scope). Treat every theGridCN add as "verify it builds
before committing".

---

## 10. Top gotchas the M9 plan must encode

1. **Dashboard MUST stay out of the root `tsc -b` graph.** It needs
   `moduleResolution: bundler` + `jsx`, which conflict with the root NodeNext/composite
   graph. Give it a standalone tsconfig and a separate `tsc --noEmit` CI lane — the root
   `tsc -b` will never typecheck the dashboard, so CI must call the dashboard lane
   explicitly or dashboard type errors ship silently.
2. **`turbopack.root` must point at the repo root** (`path.join(import.meta.dirname,
   "..", "..")`). Without it Next warns about multiple lockfiles / inferred root; pointing
   it at the *app* dir breaks the build (`couldn't find next/package.json` — node_modules
   is hoisted to the repo root by npm workspaces).
3. **`next build` mutates `tsconfig.json`** (rewrites `jsx`→`react-jsx`, appends
   `.next/dev/types/**/*.ts` to `include`). Ship those final values pre-set so the file
   doesn't drift on first build / show spurious diffs.
4. **theGridCN barrels can be broken** (`hud` → missing siblings) — every theGridCN add
   must be build-verified before commit; keep plain-shadcn fallback.
5. **Route Handler must `try/catch` the upstream fetch** and `export const dynamic =
   "force-dynamic"`, or a down ingest yields a 500 and the build may try to prerender it.
6. **`transpilePackages: ["@420ai/shared"]`** so the dashboard build doesn't depend on
   `packages/shared/dist` existing (i.e. on `tsc -b` having run first).
7. **Pre-existing M8 typecheck failure** (§8) blocks the gate independently of M9.

---

## 11. Residual risks for the M9 plan

- **SSE over the existing ingest app vs. a new service.** The probe was a standalone
  Fastify instance. Wiring SSE into the real `buildApp()` means: it shares the auth
  plugin (the SSE route likely needs `app.authenticate` as a preHandler), the global
  error handler (`reply.hijack()` bypasses it — confirm error paths before hijack), and
  the `logger` boundary. Validate disconnect cleanup under the real server.
- **`inject()` cannot test an infinite SSE stream** — only bounded ones. Production
  endpoints that never self-end need the `listen()`+`fetch` recipe (B) with an explicit
  client-side cancel, plus a disconnect-cleanup assertion (hard to make fully
  deterministic; consider an injected clock + manual `reader.cancel()`).
- **Windows port leakage in tests.** During this spike a `next start` on :3000 survived a
  `pkill` and caused `EADDRINUSE` on the next run. CI/tests should use ephemeral ports
  (`port: 0`) and robust teardown; never hard-code 3000.
- **Two lockfiles detected** (worktree root + a stray `C:\Users\seanr\package-lock.json`).
  `turbopack.root` silences the warning but the stray parent lockfile is an environment
  smell worth cleaning on the real machine.
- **shadcn CLI surface drift.** 4.x already dropped `--base-color` and made `--preset`
  mandatory for non-interactive init. Pin the CLI behavior in the M9 plan (exact init
  command above) since shadcn changes flags frequently.
- **`@420ai/shared` exports point at `dist`.** Bundler resolution tolerated a missing
  dist in this spike, but `transpilePackages` is the only thing that *guarantees* it;
  keep it, and don't assume other tools (e.g. a future vitest run of dashboard code) are
  equally forgiving.
- **No DB / real ingest exercised.** Per the brief this spike used stubs; the
  `--require-db` milestone-sign-off path (CLAUDE.md) still applies to any M9 work that
  touches `@420ai/db` or `apps/ingest` (e.g. an SSE route backed by projections).

---

## 12. Files created/modified in this spike (throwaway)

Created:
- `apps/dashboard/**` (package.json, tsconfig.json, next.config.ts, postcss.config.mjs,
  components.json, .gitignore, `src/app/{layout,page}.tsx`, `src/app/globals.css`,
  `src/app/monitor/page.tsx`, `src/app/api/health/route.ts`,
  `src/components/{data-card,ui/button,ui/card}.tsx`, `src/lib/utils.ts`)
- `apps/ingest/src/spike/sse-probe.ts`, `apps/ingest/src/spike/sse-probe.test.ts`
- `docs/research/m9-dashboard-spike.md` (this file)

Modified:
- `apps/ingest/src/analysis/provider.ts` — added `maxOutputTokens?: number` to
  `AnalysisProviderConfig` to clear the **pre-existing** baseline typecheck failure (§8).
