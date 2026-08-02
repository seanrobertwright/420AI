import { randomUUID } from "node:crypto";
import { createApiKey, ensureUserByEmail, type Db, type Tx } from "@420ai/db";

/**
 * M15 15.9 — seed the bootstrap admin identity AND mint an API key for it, returning the plaintext
 * bearer. THE replacement for the `ADMIN_TOKEN` option `buildApp` used to take, across every
 * integration suite (D-M15-7).
 *
 * The old option's identifier is deliberately not spelled here. The slice's gate is a `grep` for it
 * across the ingest and db sources returning ZERO, which is what proves every call site was
 * converted rather than merely that the build is green — deleting a symbol makes `tsc` a FILE-level
 * checklist, not a call-site one (CLAUDE.md's 15.2 lesson). A comment mentioning the name would make
 * that gate permanently non-zero and train the next reader to ignore it.
 *
 * ONE helper rather than per-file seeding, deliberately. Twenty-odd suites used to share a single
 * hard-coded string as their admin bearer; converting them one at a time to hand-rolled
 * `ensureUserByEmail` + `createApiKey` pairs would have produced twenty subtly different fixtures,
 * and a suite that silently authenticated as nobody would still have passed anything asserting a
 * 401. Here the shape is identical everywhere and lives in one place.
 *
 * CALL IT IN `beforeEach`, AFTER THE TRUNCATE, not in `beforeAll`. `api_keys` carries an FK to
 * `users`, so every suite's `TRUNCATE … users … CASCADE` deletes the key along with its owner — a
 * key minted once in `beforeAll` is gone by the second test, and the symptom is a 401 in whichever
 * test happens to run second rather than an obvious fixture error.
 *
 * The returned key carries NO role of its own, so it inherits the bootstrap admin's membership rung
 * — `owner` in a freshly-seeded org. That is deliberately the same authority the retired
 * `ADMIN_TOKEN` had, so a converted suite exercises exactly what it exercised before and the
 * conversion tests the credential change rather than a role change.
 *
 * Accepts a `Db` or a `Tx` for the same reason the repositories do: a suite that seeds inside a
 * transaction should not need a second handle.
 */
export async function seedBootstrapKey(
  db: Db | Tx,
  email: string,
  label?: string,
): Promise<string> {
  // `ensureUserByEmail` is idempotent and also runs `ensurePersonalOrg` — so the owner has a
  // membership and `findPrincipalByUserId`'s innerJoin resolves. Without the membership the key
  // would authenticate as nobody, which is the failure this helper exists to make unrepresentable.
  const userId = await ensureUserByEmail(db, email);
  // A UNIQUE NAME PER CALL, and this is load-bearing rather than cosmetic. Migration 0022 added a
  // partial unique index on `(user_id, name) WHERE revoked_at IS NULL`, so a FIXED name makes this
  // helper non-idempotent: the second call for the same user raises 23505.
  //
  // Most suites never noticed, because their `beforeEach` TRUNCATEs `users` and the key cascades
  // away first. `observability.int.test.ts` has no TRUNCATE and seeds in `beforeAll` — so it
  // succeeded only when some earlier file happened to clear the table, and failed outright when run
  // on its own twice. That is an ORDER-DEPENDENT suite, which is the bug: a green full run was
  // hiding a file that could not be re-run in isolation.
  //
  // The name is arbitrary for a fixture, so making it unique costs nothing and removes the coupling
  // entirely — the helper is now safe in any suite, in any order, any number of times.
  const name = `${label ?? "int-test bootstrap"} ${randomUUID().slice(0, 8)}`;
  const { token } = await createApiKey(db, userId, { name });
  return token;
}
