import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * M15 15.3 — the SOURCE-LEVEL completeness assertion. This test exists because of a lesson
 * CLAUDE.md records verbatim:
 *
 *   Deleting `adminAuthorized` in 15.2 was expected to raise ~45 errors (one per gate). It
 *   raised 16 — one per FILE, on the failed named import. "TypeScript binds a failed import as
 *   an error type and stops re-reporting at each usage." So `tsc -b` exiting 0 does NOT prove
 *   every call site was converted; pair it with a grep assertion.
 *
 * Wrapping 53 handlers in `withOrg` has the IDENTICAL failure shape, and it is worse: a missed
 * handler compiles perfectly, passes every owner-connected integration test (the owner bypasses
 * RLS), and silently reads with no org context — which under the app role is an empty result
 * set the user experiences as "my data vanished", or, before this slice, another tenant's rows.
 * `tsc` cannot catch that. This is the grep half of the rule.
 *
 * The check: any route file that resolves a principal AND touches a repository must also call
 * `withOrg` — unless it is on the explicit, commented allow-list below.
 *
 * KNOWN LIMIT, stated because it already bit this branch: this check is FILE-granular. One
 * `withOrg(` anywhere in a file exempts the whole file, so a file with one wrapped call and one
 * unwrapped call passes. `/lril:code-review` found exactly that in `monitor.ts` (the alert
 * DELIVERY pass ran on the unwrapped `app.db`, read zero rows under the app role, and silently
 * stopped sending every webhook and email) while this suite was green.
 *
 * Making the regex exact is not possible — source text cannot tell a `Tx` from a `Db`. The
 * durable answer is a BEHAVIOURAL test on the app role, and that is where the fix lives:
 * `apps/ingest/src/rls.int.test.ts` test 9 asserts a firing is actually delivered and stamped.
 * Treat this file as a cheap first net, never as proof of coverage.
 */

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Files that legitimately reach `app.db` WITHOUT `withOrg`. Every entry is a decision, not an
 * exception granted to make a test pass — adding one should require the same argument these
 * did. Keep in sync with each file's own header comment.
 */
const ALLOWED_WITHOUT_WITHORG: Record<string, string> = {
  // Deployment-GLOBAL tables (D-M15-9): no `org_id` column, therefore no policy (D-15.3-4).
  "catalog.ts": "pricing_catalogs is deployment-global — no org_id, no policy",
  "connector-catalog.ts": "connector_catalogs is deployment-global — no org_id, no policy",
  // Identity tables the org resolution itself reads — a policy here would be circular.
  "auth.ts": "reads `users` to ESTABLISH identity; users/organizations/memberships carry no RLS",
  // The BOOTSTRAP paths (D-15.3-3) — circular with respect to tenancy by construction.
  "pair.ts": "redeems the pairing code IN ORDER TO discover the org (bootstrap-permissive)",
  "pairing-codes.ts": "writes a row for a TARGET user whose org is not the caller's (D-15.2-5)",
  // No DB access at all.
  "health.ts": "no tenant DB access",
  "metrics.ts": "no tenant DB access",
};

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"));
}

describe("every route that touches tenant data is org-scoped", () => {
  it("finds the route files (guards against the glob silently matching nothing)", () => {
    // A structural test that scans zero files passes vacuously — the worst kind of green.
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain("projections.ts");
  });

  it("every file reaching app.db either calls withOrg or is on the allow-list", () => {
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!src.includes("app.db")) continue; // no DB access at all
      if (src.includes("withOrg(")) continue; // scoped
      if (file in ALLOWED_WITHOUT_WITHORG) continue; // decided exemption
      offenders.push(file);
    }
    expect(
      offenders,
      `these route files reach app.db without withOrg and are not on the allow-list — ` +
        `wrap them, or add an entry to ALLOWED_WITHOUT_WITHORG with a reason`,
    ).toEqual([]);
  });

  it("the allow-list has no stale entries (every named file still exists)", () => {
    // An allow-list that outlives its file is a hole waiting for a same-named newcomer.
    const files = new Set(routeFiles());
    for (const allowed of Object.keys(ALLOWED_WITHOUT_WITHORG)) {
      expect(files.has(allowed), `allow-list names ${allowed}, which no longer exists`).toBe(true);
    }
  });

  it("every allow-listed file explains itself in its own source, not only here", () => {
    // The reason must live where the next reader is: at the top of the file they are editing.
    for (const allowed of Object.keys(ALLOWED_WITHOUT_WITHORG)) {
      const src = readFileSync(join(ROUTES_DIR, allowed), "utf8");
      if (!src.includes("app.db")) continue; // health/metrics have nothing to explain
      expect(src, `${allowed} must document WHY it is not wrapped`).toMatch(/M15 15\.3/);
    }
  });

  it("each principal-authed handler file that reads tenant data calls withOrg", () => {
    // The narrower, higher-signal form: a file with `resolvePrincipal` almost always serves
    // tenant data, so a missing `withOrg` there is the exact 15.2-shaped miss this pins.
    const missing: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!src.includes("resolvePrincipal")) continue;
      if (src.includes("withOrg(")) continue;
      if (file in ALLOWED_WITHOUT_WITHORG) continue;
      missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it("machine-authed write routes resolve the org before wrapping", () => {
    // These have no request principal, so `withOrg` alone is not enough — they must derive the
    // org from `machines` first (which is why `machines` is bootstrap-permissive, D-15.3-3).
    for (const file of ["ingest.ts", "heartbeat.ts", "git.ts"]) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      expect(src, `${file} must resolve the machine's org`).toContain("getMachineOrgId");
      expect(src, `${file} must wrap its tenant writes`).toContain("withOrg(");
    }
    // workspaces.ts resolves via the machine's owning user (the documented 15.2 seam).
    const ws = readFileSync(join(ROUTES_DIR, "workspaces.ts"), "utf8");
    expect(ws).toContain("getOrgIdForUser");
    expect(ws).toContain("withOrg(");
  });

  it("the alert delivery pass is org-scoped (the file-granular check's known blind spot)", () => {
    // The one call this suite structurally CANNOT see, pinned by name. `alert_firings` carries
    // a strict policy, so a delivery pass with no org context reads zero rows — no error, no
    // log, just silence, on the path that sends every webhook and email. The real proof is
    // behavioural (rls.int.test.ts test 9); this is the cheap tripwire beside it.
    const src = readFileSync(join(ROUTES_DIR, "monitor.ts"), "utf8");
    expect(src, "deliverFirings must take an orgId").toMatch(
      /deliverFirings\(\s*app,\s*[\w.]*[Oo]rgId/,
    );
    expect(src).toMatch(/deliverPendingFirings\(app\.db,\s*orgId,/);
    expect(src).toMatch(/deliverResolvedFirings\(app\.db,\s*orgId,/);
  });

  it("the deployment-wide maintenance ops iterate per org rather than escaping the policy", () => {
    // D-15.3-5. Under the app role an unwrapped pass sees zero rows and would silently report
    // `{repriced: 0}` — success having done nothing.
    for (const file of ["replay.ts", "search.ts"]) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      expect(src, `${file} must loop over orgs`).toContain("listOrganizations");
      expect(src).toContain("withOrg(");
    }
  });
});
