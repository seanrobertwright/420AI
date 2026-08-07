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
  // M15 15.6 EXTENDS this reason rather than leaving it to quietly under-describe the file — the
  // comment two entries down explains why a stale justification here is worse than a missing one.
  // `auth.ts` now also reads and WRITES `sessions`, which is likewise an identity table with no
  // `org_id` and no policy (D-15.6-3), and for the same circularity: `resolvePrincipal` reads that
  // row at the one moment before any org context exists, because resolving it is part of what
  // establishes the context. A session is owned by a USER, not an org, so `userId` — not `orgId` —
  // is the scoping predicate on every call.
  "auth.ts":
    "reads `users` to ESTABLISH identity and `sessions` to establish the request context; " +
    "users/organizations/memberships/sessions carry no RLS",
  // M15 15.7 — the SAME argument as `auth.ts` above, one table further along. `sso_identities` is
  // an identity table with no `org_id` and no policy (D-15.7-3), and the login path reads it at the
  // one moment before any org context exists, because resolving that row is part of what
  // establishes the context. An identity belongs to a USER, so `userId` is the scoping predicate on
  // every call — there is no `orgId` in the repository's signatures at all.
  //
  // The file DOES write org-owned rows on one path: invite-acceptance inserts a `memberships` row.
  // That is not an exemption being stretched — it goes through `acceptInvite`, exactly as
  // `auth.ts`'s password invite-accept does, and `invites`/`memberships` are the bootstrap-permissive
  // and no-policy tables that path was designed around (D-15.3-3 / D-15.5-2). Wrapping it in
  // `withOrg` would read zero rows, since the invite lookup is what discovers the org.
  //
  // M15 15.10 EXTENDS this reason too, and for the same "a stale justification is a hole" argument.
  // The invite-acceptance path now also writes `audit_events` (`member.joined`), which DOES carry an
  // `org_id` and DOES carry a policy — so the phrase "touches no tenant table" would have quietly
  // stopped being true. It is not an exemption being stretched: the policy is a single unconditional
  // `FOR INSERT WITH CHECK (true)` (D-15.10-2), so the append needs NO org context to succeed, which
  // is precisely why it can be called from this file. Wrapping in `withOrg` here would still read
  // zero rows, since the invite lookup is what discovers the org.
  "sso.ts":
    "reads `sso_identities` + `users` to ESTABLISH identity before any org context exists; " +
    "sso_identities/users/memberships carry no RLS, `invites` is bootstrap-permissive, and " +
    "`audit_events` is append-only with an unconditional INSERT policy (D-15.10-2)",
  // M15 15.8 — the SAME argument as `auth.ts`/`sso.ts` above, two tables further along. A second
  // factor is presented BEFORE a session is minted, so `POST /v1/auth/mfa/verify` reads these rows at
  // the one moment before any org context exists — resolving them is part of what establishes it. The
  // five session-gated routes in the file act on `principal.userId` and touch no tenant table at all.
  //
  // M15 15.10 — the "touch no tenant table at all" clause above is now qualified rather than left to
  // rot. `mfa.ts` remains un-audited itself (self-service credential changes are outside
  // AUDIT_ACTIONS by decision — see `packages/shared/src/audit.ts`), but the ADMIN-initiated reset
  // that 15.8 parked landed in `members.ts`, which IS `withOrg`-wrapped. Stated here because the
  // next reader will look for the reset in this file.
  "mfa.ts":
    "reads totp_credentials/mfa_recovery_codes to complete authentication before any org context " +
    "exists; both are identity tables with no org_id and no policy (D-15.8-13); the ADMIN MFA " +
    "reset lives in members.ts, wrapped, and is the only audited MFA action",
  // M15 15.9 — the SAME argument again, one table further along. `api_keys` is an IDENTITY table
  // with no `org_id` and no policy (D-15.9-1), read INSIDE `resolvePrincipal` at the one moment
  // before any org context exists, because resolving the row is part of what establishes it. All
  // three routes in the file act on `principal.userId` and touch no tenant table at all — the
  // `userId` predicate inside every repository call IS the whole scoping, and there is no policy
  // for `withOrg` to activate.
  //
  // M15 15.10 — "touch no tenant table at all" STOPPED BEING TRUE in this slice, and this is the
  // exemplary case of why these reasons get extended rather than left alone: the mint and both
  // revoke handlers now write `audit_events`, which carries an `org_id` AND a policy. The entry
  // stays, because the append-only policy is a single unconditional `FOR INSERT WITH CHECK (true)`
  // (D-15.10-2) that needs no org context — and that is not an assumption, it is SPIKE check 8's
  // negative control: a STRICT policy here would have REJECTED the insert and made every mint a
  // 500. The audit row still carries `principal.orgId`; an audit event is an act within an org even
  // when the object it acts on is org-less. The transactions in that file are for ATOMICITY.
  "api-keys.ts":
    "reads/writes api_keys, an identity table with no org_id and no policy (D-15.9-1), resolved " +
    "inside resolvePrincipal before any org context exists; also appends to `audit_events`, whose " +
    "unconditional INSERT policy needs no org context (D-15.10-2)",
  // The BOOTSTRAP paths (D-15.3-3) — circular with respect to tenancy by construction.
  "pair.ts": "redeems the pairing code IN ORDER TO discover the org (bootstrap-permissive)",
  // M15 15.5 REMOVED `pairing-codes.ts`. Its exemption read "writes a row for a TARGET user whose
  // org is not the caller's (D-15.2-5)", and D-M15-8 made that false: the route now resolves an
  // EXISTING MEMBER of the caller's org and 404s otherwise, so every row it writes is same-org by
  // construction and it is `withOrg`-wrapped like any other principal-authed handler. The entry was
  // deleted rather than re-worded — the "no stale entries" test below only catches an allow-listed
  // file that no longer EXISTS, never one whose stated reason has quietly stopped being true, so an
  // obsolete justification would sit here as a hole for the next reader to widen.
  // No DB access at all.
  "health.ts": "no tenant DB access",
  "metrics.ts": "no tenant DB access",
};

/**
 * M15 15.4 — files that resolve a principal but legitimately carry NO `authorized()` gate.
 * Deliberately tiny: everything else, including every read, gates at least at `viewer`.
 */
const ALLOWED_WITHOUT_ROLE_GATE: Record<string, string> = {
  // `health.ts` has no principal at all; listed for symmetry with the withOrg allow-list.
  "health.ts": "unauthenticated liveness probe — no principal to gate",
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

  it("every principal-authed handler file also calls the M15 15.4 role gate", () => {
    // The 15.4 sibling of the check above, and it exists for the same reason: `tsc` cannot see
    // a MISSING call. `authorized()` is an ordinary function — forgetting it at a handler is not
    // a type error, it is a route anyone in the org may hit at full power.
    //
    // SAME KNOWN LIMIT as the `withOrg` check, and it is file-granular for the same unfixable
    // reason: ONE `authorized(` anywhere exempts the whole file, so a file with four handlers
    // and one gate passes. That is precisely the `monitor.ts` blind spot the header documents.
    // The behavioural counterpart is `apps/ingest/src/rbac.int.test.ts`, which drives real HTTP
    // requests as a real viewer and a real member. Treat this as the cheap net, never as proof.
    const missing: string[] = [];
    for (const file of routeFiles()) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!src.includes("resolvePrincipal")) continue;
      if (src.includes("authorized(")) continue;
      if (file in ALLOWED_WITHOUT_ROLE_GATE) continue;
      missing.push(file);
    }
    expect(
      missing,
      `these route files resolve a principal but never gate on its role — add the ` +
        `authorized(...) check, or add an entry to ALLOWED_WITHOUT_ROLE_GATE with a reason`,
    ).toEqual([]);
  });

  it("the role-gate allow-list has no stale entries", () => {
    const files = new Set(routeFiles());
    for (const allowed of Object.keys(ALLOWED_WITHOUT_ROLE_GATE)) {
      expect(files.has(allowed), `allow-list names ${allowed}, which no longer exists`).toBe(true);
    }
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
    // M15 15.4 added the role argument. It must be SERVICE_ROLE, never `principal.role`:
    // delivery is TRIGGERED by whoever opened the monitor but the ACTION belongs to the org,
    // and a viewer's role would make the 0016 restrictive UPDATE policy silently reject the
    // `delivery_attempted_at` stamp — reviving this exact bug one layer down.
    //
    // M16 16.7 replaced the bare `orgId` argument with a `FiringScope`, so the shape this pins is
    // now `(app.db, <scope>, SERVICE_ROLE, …)`. The SERVICE_ROLE position is the load-bearing half
    // and it is unchanged. `orgScope` and `deploymentScope` are the two local consts in
    // `deliverFirings`; matching them by name is deliberately stricter than `\w+` — a delivery pass
    // handed some other object would fail here rather than pass on a shape coincidence.
    expect(src).toMatch(
      /deliverPendingFirings\(\s*app\.db,\s*(orgScope|deploymentScope),\s*SERVICE_ROLE,/,
    );
    expect(src).toMatch(
      /deliverResolvedFirings\(\s*app\.db,\s*(orgScope|deploymentScope),\s*SERVICE_ROLE,/,
    );
    // BOTH scopes must be delivered, or one of them is silently never sent. The deployment scope
    // is the easier one to lose: it is a single row for the whole installation, so a missing pass
    // shows up as "we just never got an email about the pricing catalog" and nothing else.
    expect(src, "the org delivery pass must exist").toContain("orgScope");
    expect(src, "the deployment delivery pass must exist").toContain("deploymentScope");
    // …and the deployment scope must be spelled as the deployment, never as a borrowed org id.
    expect(src).toMatch(/deploymentScope\s*=\s*\{\s*kind:\s*"deployment"\s*\}/);
  });

  it("the deployment reconcile runs under withDeployment, not a borrowed org context", () => {
    // M16 16.7 (D-16.7-4). The two deployment-scoped alert codes derive from tables with no
    // `org_id`, so their firing row has `org_id IS NULL` and must be written with NO org context —
    // `withDeployment`, whose whole contract is that it sets the role and deliberately leaves
    // `app.current_org` unset. Wrapping it in some org's `withOrg` instead would typecheck, pass
    // every test that only counts rows, and quietly re-attribute a deployment-wide condition to
    // whichever org happened to load the monitor first — which is the defect 16.7 exists to fix,
    // reintroduced in the fix itself.
    const src = readFileSync(join(ROUTES_DIR, "monitor.ts"), "utf8");
    expect(src, "the deployment reconcile must open a deployment context").toMatch(
      /withDeployment\(\s*app\.db,\s*SERVICE_ROLE,/,
    );
    // Throttled through the shared sentinel, not unconditionally: the SSE path reconciles every
    // 3 s per connected client, and this is ONE row shared by the whole deployment.
    expect(src, "the deployment reconcile must be throttled").toContain("DEPLOYMENT_THROTTLE_KEY");
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
