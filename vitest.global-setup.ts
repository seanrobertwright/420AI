import { runMigrations } from "@420ai/db";

/**
 * Vitest global setup: migrate the test database once before the suite so
 * *.int.test.ts hit a ready schema. If DATABASE_URL_TEST is unset (no Docker),
 * this is a no-op and the integration suites self-skip. Migrations are
 * idempotent, so re-runs across sessions are safe.
 */
export default async function setup(): Promise<() => void> {
  const url = process.env.DATABASE_URL_TEST;
  if (url) {
    await runMigrations(url);
  }
  return () => {};
}
