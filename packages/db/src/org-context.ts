import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";

/**
 * M15 15.3 — the Row-Level-Security context primitive (D-M15-3's BACKSTOP layer).
 *
 * 15.2 threaded an explicit `orgId` predicate into every tenant-touching read. That is the
 * PRIMARY defence and it is only as good as the reviewer who last looked at a query. RLS is
 * the backstop: a read that forgets its predicate returns ZERO rows instead of another
 * tenant's data. The policies (migration 0015) key on a transaction-local setting, and this
 * function is the only thing that sets it.
 *
 * Two findings from `docs/research/m15-rls-spike.md` are load-bearing here:
 *
 *   - FINDING 3 — a plain `SET` leaks tenant context ACROSS pooled connection checkouts. The
 *     next request to draw that connection inherits the previous request's org. `SET LOCAL`
 *     semantics (scope = the enclosing transaction) is therefore mandatory, which is why this
 *     wrapper opens a transaction rather than merely setting a variable.
 *   - FINDING 4 — `SET LOCAL app.current_org = $1` is REJECTED by Postgres: `SET` is not a
 *     parameterizable statement. The naive workaround is to interpolate the org id into the
 *     SQL string, i.e. to open a SQL-injection hole INSIDE the isolation primitive. Never
 *     write it that way. `set_config(setting, value, is_local)` is an ordinary function call
 *     with exact `SET LOCAL` semantics when `is_local = true`, so the value binds normally.
 *
 * Assertions this must keep satisfying (pinned by `repositories/rls.int.test.ts`):
 *   1. an org-A context sees only org-A rows; an UNSET context sees ZERO rows;
 *   2. the context does not survive `COMMIT`, `ROLLBACK`, or a thrown callback;
 *   3. a subsequent transaction that does not call `set_config` sees zero rows.
 *
 * NOTE the parameter type is `Db`, NOT `DbClient`. A `Tx` cannot open a top-level
 * transaction, so passing one would silently produce a SAVEPOINT whose `set_config` scope is
 * the OUTER transaction. `DbClient.transaction()` *does* typecheck (drizzle types nested
 * savepoints), so the compiler will not catch that mistake — this parameter type is the only
 * guard.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // A BLANK org id is the one input that quietly breaks the whole scheme, so it is rejected
  // here rather than defended against per-policy. `set_config` accepts '' happily, and the
  // policies then `nullif(…, '')` it straight back to NULL — which makes the 12 STRICT tables
  // fail closed (fine) but the 3 BOOTSTRAP-PERMISSIVE ones fully OPEN for the whole
  // transaction (not fine). A half-open context is worse than either extreme because nothing
  // errors. Every caller today derives `orgId` from the database, so this never fires; it
  // exists to keep that true.
  if (!orgId.trim()) {
    throw new Error("withOrg requires a non-empty orgId — a blank org context is not scoping");
  }
  return db.transaction(async (tx) => {
    // set_config(..., true) == SET LOCAL, but PARAMETERIZED.
    // `SET LOCAL app.current_org = ${orgId}` is REJECTED by Postgres (15.0 Finding 4.1) and
    // would require string interpolation — never write it that way.
    await tx.execute(sql`SELECT set_config('app.current_org', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * The non-owner application role the ingest server connects as. RLS is INERT against the
 * owner/superuser in `DATABASE_URL` (`rolbypassrls`), and `FORCE ROW LEVEL SECURITY` removes
 * only the table-OWNER exemption, not the superuser one — two distinct exemptions, two
 * distinct switches (15.0 Finding 1). Shared spelling for the migration, the provisioning CLI
 * and the two-role test suite.
 */
export const APP_ROLE_NAME = "420ai_app";

/** The transaction-local setting every RLS policy reads. Shared spelling; see `withOrg`. */
export const ORG_SETTING = "app.current_org";
