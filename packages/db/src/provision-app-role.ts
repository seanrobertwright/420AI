import { Pool } from "pg";
import { APP_ROLE_NAME } from "./org-context.js";

/**
 * M15 15.3 — provision the non-owner application role the ingest server connects as.
 *
 * Migration 0015 creates the role `NOLOGIN` and grants it table privileges, so it is
 * self-sufficient as SCHEMA. What it deliberately does NOT do is set a password: a migration
 * file is committed to git, and a secret in one is a secret in the repo forever. This engine
 * owns the credential half — it grants LOGIN and sets the password from the environment.
 *
 * IDEMPOTENT on purpose. Running it again is the documented PASSWORD ROTATION path
 * (`docs/guide/operations.md`): change `APP_DB_PASSWORD`, re-run, update `DATABASE_URL_APP`.
 * The `CREATE ROLE` guard is repeated here (rather than assumed from the migration) so this
 * works against a database where migrations have not been applied yet.
 *
 * Silent library (CLAUDE.md process-boundary rule): throws, never logs, never `process.exit`.
 * In particular it never logs the password or a URL containing it — the CLI entrypoint prints
 * only a secret-free confirmation.
 *
 * @param ownerUrl a connection string for the OWNER role (`DATABASE_URL`) — creating a role
 *   and altering its password both require privileges the app role does not have.
 */
export async function provisionAppRole(ownerUrl: string, password: string): Promise<void> {
  if (!password) throw new Error("app role password must be a non-empty string");

  const pool = new Pool({ connectionString: ownerUrl });
  try {
    // Server-side quoting here too (PR #63 review) — not because `APP_ROLE_NAME` is untrusted
    // (it is a module constant), but because two statements three lines apart should not teach
    // opposite lessons about building SQL.
    //
    // Note this is a THIRD instance of the same trap: `DO $$ … $$` is itself a utility
    // statement, so wrapping the guard in a DO block and binding `$1` into it does NOT work
    // either — DO takes no parameters. The check therefore runs as an ordinary parameterized
    // SELECT, and only the CREATE is built by `format(… %I …)`.
    const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      APP_ROLE_NAME,
    ]);
    if (rowCount === 0) {
      const [create] = (
        await pool.query<{ stmt: string }>(
          `SELECT format('CREATE ROLE %I NOLOGIN', $1::text) AS stmt`,
          [APP_ROLE_NAME],
        )
      ).rows;
      try {
        await pool.query(create!.stmt);
      } catch (e) {
        // 42710 duplicate_object — a concurrent provisioner won the race between the SELECT
        // above and this CREATE. That is the outcome we wanted, so it is not an error.
        if ((e as { code?: string }).code !== "42710") throw e;
      }
    }
    // `ALTER ROLE ... PASSWORD $1` is REJECTED (`syntax error at or near "$1"`, SQLSTATE
    // 42601): like `SET`, ALTER ROLE is a utility statement and takes no bind parameters. This
    // is the SAME trap as 15.0 Finding 4, one statement over — and the naive fix is the same
    // injection hole: interpolating the password into the SQL string ourselves.
    //
    // So we let POSTGRES do the quoting. `format(..., %L)` is `quote_literal`, `%I` is
    // `quote_ident` — server-side, correct for every edge case (embedded quotes, backslashes,
    // E'' strings) in a way hand-rolled escaping is not. The password DOES travel as a literal
    // in the second statement's text, which is unavoidable: every documented password-setting
    // path (including `psql \password`) puts it there. It is never logged by us.
    const [built] = (
      await pool.query<{ stmt: string }>(
        `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS stmt`,
        [APP_ROLE_NAME, password],
      )
    ).rows;
    try {
      await pool.query(built!.stmt);
    } catch (e) {
      // Scrub: a raw pg error can carry the offending statement — and this one holds the
      // secret. Re-throw without it (CLAUDE.md: libraries throw typed errors, never leak).
      throw new Error(
        `failed to set password for role ${APP_ROLE_NAME}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } finally {
    await pool.end();
  }
}
