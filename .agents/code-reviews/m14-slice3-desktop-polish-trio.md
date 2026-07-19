# Code Review — M14 Slice 14.3 (Desktop polish trio)

**Branch:** `m14-slice3-desktop-polish-trio`
**Reviewed:** connector health table (`SyncHealth.tsx`), `/api/auth/me` proxy, admin-email nav (`app-nav.tsx`), milestone-doc correction.

**Stats:**

- Files Modified: 3 (`apps/desktop/src/components/SyncHealth.tsx`, `apps/dashboard/src/components/app-nav.tsx`, `.agents/plans/m14-general-ai-chat-capture.md`)
- Files Added: 1 (`apps/dashboard/src/app/api/auth/me/route.ts`)
- Files Deleted: 0
- New lines: 113
- Deleted lines: 4

---

## Findings

### 1 — Admin-email probe re-fetches on every client navigation

```
severity: low
file: apps/dashboard/src/components/app-nav.tsx
line: 40
issue: useEffect deps [pathname] re-fire the /api/auth/me fetch on every route change.
detail: `usePathname()` changes on each client-side navigation, so the effect re-runs and
        issues a fresh authenticated round-trip to ingest (/api/auth/me is force-dynamic +
        no-store) on every nav click. The admin email is invariant for a session, so all
        fetches after the first are redundant. Not a correctness bug — the `alive` guard
        prevents post-unmount setState and errors are swallowed — but it is unnecessary
        network + ingest load that grows with navigation.
suggestion: Short-circuit once the email is known: guard the effect body with
        `if (pathname === "/login" || email) return;` and add `email` to the dependency
        array (keeps react-hooks/exhaustive-deps satisfied; the guard makes the re-run on
        email-set a no-op, so there is no loop). One-shot semantics, lint-clean.
```

---

## Reviewed and cleared (no issue)

- **`ConnectorsTable` (`SyncHealth.tsx:238-289`)** — divide-by-zero is guarded on `toolCalls`
  (`=== 0 → "—"`, never `n / 0`); `formatAgo` already returns `"—"` for `null lastEventAt`; ISO
  is not re-coerced (server-side aggregate normalization already applied); `key={c.sourceConnector}`
  is unique; failure badge uses the existing `SEVERITY_BADGE.critical`. Logic correct.
- **`/api/auth/me/route.ts`** — exact mirror of `catalog/route.ts` GET; `force-dynamic` on the
  route file; no `NextRequest` needed (no body); no auth logic (proxyJson/middleware own it).
  Correct.
- **Rules of Hooks (`app-nav.tsx`)** — both `useState` and `useEffect` are declared ABOVE the
  `if (pathname === "/login") return null` guard. Compliant (also enforced by lint + next build,
  both green).
- **Proxy / token discipline** — the browser never holds `ADMIN_TOKEN`; the email is fetched
  through the same-origin `/api/auth/me` proxy, which adds the bearer on the server→ingest hop.
  No `NEXT_PUBLIC_*` token. Compliant with `CLAUDE.md` "Frontend workspace".
- **Layout margin logic (`app-nav.tsx`)** — `ml-auto` on the span when present, `!email && "ml-auto"`
  on Logout otherwise; no competing-auto-margin split. Right-alignment holds in both states.
- **Resource teardown** — only new async resource is a one-shot fetch with `alive`-flag cleanup
  armed in the effect return. No interval/stream/listener/proxied-upstream fetch added; M9 leak
  class not triggered.

**Security:** no injection surface (no SQL, no `dangerouslySetInnerHTML`, no user-controlled
markup), no exposed secrets. CLEAR.

**Verdict:** 1 low-severity efficiency finding; no critical/high/medium issues. Recommend applying
the low fix (it removes redundant per-navigation ingest round-trips at zero readability cost).

---

## Fix applied (`/lril:code-review-fix`)

- **Finding 1 — FIXED.** Effect guard changed to `if (pathname === "/login" || email) return;` with
  `email` added to the deps array (`app-nav.tsx:37,49`). The probe now fires once; the re-run when
  `email` flips null→value is a no-op. Re-validated: `prettier --check` clean, `typecheck:dashboard`
  0 errors, `lint` 0 (no `exhaustive-deps` warning), `build:dashboard` compiled ✓.
