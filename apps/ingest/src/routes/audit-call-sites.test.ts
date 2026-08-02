import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * M15 15.10 — D-15.10-3, GUARDED AT THE CALL SITE.
 *
 * The decision is that an audit row is atomic with the action it records: a failed audit FAILS the
 * action, because "the change committed but nobody knows who made it" is the worse outcome. The way
 * that breaks in practice is not exotic — a handler passes `app.db` where it meant to pass its
 * `tx`. Then the audit row commits on its own connection: the action rolls back, the row survives,
 * and the log asserts a change that never happened, permanently, in the one table the application
 * cannot correct.
 *
 * NOTHING ELSE CATCHES IT:
 *   - `tsc` cannot, because `recordAuditEvent` takes a `DbClient` — a `Db` OR a `Tx` — and that is
 *     deliberate: the identity routes (`api-keys.ts`, `auth.ts`, `sso.ts`) genuinely have no `tx`
 *     from `withOrg` and pass their own `app.db.transaction` handle.
 *   - the repository-level test in `audit.int.test.ts` cannot, because it never sees a route's
 *     argument — and its rollback assertion additionally cannot detect self-wrapping, since drizzle
 *     turns a nested transaction on a `Tx` into a SAVEPOINT that rolls back with its parent. That
 *     was measured, not assumed.
 *
 * So this is a SOURCE-TEXT check, with all the limits that implies: it reads the identifier passed
 * as the first argument, and source text cannot tell a `Tx` from a `Db` in general. It is a cheap
 * first net for the one spelling that is always wrong (`app.db`), in the same register as
 * `org-scoping.test.ts` — which says the same thing about itself. The behavioural proof that the
 * rows actually land is `apps/ingest/src/audit.int.test.ts`.
 */
function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"));
}

describe("every recordAuditEvent call site passes a transaction (D-15.10-3)", () => {
  const callSites: { file: string; arg: string }[] = [];
  for (const file of routeFiles()) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/recordAuditEvent\(\s*([A-Za-z0-9_.]+)\s*,/g)) {
      callSites.push({ file, arg: m[1]! });
    }
  }

  it("finds the call sites (guards against the regex silently matching nothing)", () => {
    // A structural test that scans zero call sites passes vacuously — the worst kind of green, and
    // the exact shape this repo has been burned by three times.
    expect(callSites.length).toBeGreaterThanOrEqual(8);
    // The two kinds of call site the design turns on must BOTH be represented: a `withOrg`-wrapped
    // route and an identity route with no org context.
    expect(callSites.map((c) => c.file)).toContain("members.ts");
    expect(callSites.map((c) => c.file)).toContain("api-keys.ts");
  });

  it("no call site passes `app.db` directly", () => {
    const offenders = callSites.filter((c) => c.arg === "app.db" || c.arg.endsWith(".db"));
    expect(
      offenders.map((c) => `${c.file}: recordAuditEvent(${c.arg}, …)`),
      "D-15.10-3 — an audit write must run inside the action's transaction, or it commits on its " +
        "own and records a change that may have rolled back. Pass the `tx` from `withOrg(...)` or " +
        "from `app.db.transaction(...)`, never the pool handle.",
    ).toEqual([]);
  });
});
