import { readFileSync } from "node:fs";
import { Pool } from "pg";

/**
 * M12 12.4f — migration rollback. Drizzle generates up-only SQL and tracks applied
 * migrations in `drizzle.__drizzle_migrations` (`id SERIAL, hash text, created_at bigint`),
 * inserting one row per migration with `created_at = migration.folderMillis` (= the
 * `_journal.json` entry's `when`). This engine finds the latest-applied migration, runs its
 * hand-authored down SQL (drizzle/down/<tag>.down.sql) in a transaction, and deletes the
 * tracking row — the same key Drizzle itself uses (Spike B). Destructive: back up first.
 */
interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export type RollbackResult = { rolledBack: string } | { rolledBack: null; reason: string };

/** Roll back the single latest-applied migration: run its down SQL + delete the tracking row. */
export async function rollbackLast(
  connectionString: string,
  opts: { downDir: string; journalPath: string },
): Promise<RollbackResult> {
  const journal = JSON.parse(readFileSync(opts.journalPath, "utf8")) as { entries: JournalEntry[] };
  const pool = new Pool({ connectionString });
  try {
    const applied = await pool.query<{ created_at: string }>(
      `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    if (applied.rowCount === 0) return { rolledBack: null, reason: "no applied migrations" };
    // pg returns bigint as a string over the wire → Number() (repo "numeric is a string" gotcha).
    const createdAt = Number(applied.rows[0]!.created_at);
    const entry = journal.entries.find((e) => e.when === createdAt);
    if (!entry) return { rolledBack: null, reason: `no journal entry for created_at ${createdAt}` };

    const downSql = readFileSync(`${opts.downDir}/${entry.tag}.down.sql`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Down SQL uses the same `--> statement-breakpoint` separator Drizzle's up files use.
      for (const stmt of downSql.split("--> statement-breakpoint")) {
        const s = stmt.trim();
        if (s) await client.query(s);
      }
      await client.query(`delete from drizzle.__drizzle_migrations where created_at = $1`, [createdAt]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return { rolledBack: entry.tag };
  } finally {
    await pool.end();
  }
}
