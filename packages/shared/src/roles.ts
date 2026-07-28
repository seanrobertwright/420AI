/**
 * M15 15.4 — the four FIXED roles (D-M15-4). No user-defined roles: that is an M16
 * enterprise concern. TEXT, not a pg enum, matching `memberships.role` (schema.ts:87)
 * and every other closed set in this repo — adding a value is a code change, not a
 * migration.
 *
 * ORDERED, and the order is the whole point: gates express "admin or better" as a rank
 * comparison rather than enumerating `role === "admin" || role === "owner"`, which is
 * the form that silently omits `owner` when someone adds a rung.
 */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * The NON-PRINCIPAL role. Machine-authed writes (collector ingest/heartbeat/git/discover)
 * and the three deployment-wide maintenance ops have no request principal and therefore no
 * membership role, but they are legitimate writers. They pass this sentinel to `withOrg`.
 *
 * It is deliberately NOT a member of `Role`: it must never satisfy `hasRole`, so it can
 * never be mistaken for an authorization decision. The RLS backstop only asks
 * "is the context `viewer`?", so any non-viewer string permits the write.
 */
export const SERVICE_ROLE = "service";

/**
 * True when `role` is at least `minimum` on the ladder. An unknown role fails CLOSED.
 *
 * The guard is `Object.hasOwn`, NOT `!== undefined`, and the difference is load-bearing rather
 * than stylistic. `RANK` is an object LITERAL, so it inherits from `Object.prototype`:
 * `RANK["toString"]` is a function, `RANK["constructor"]` is a function, `RANK["__proto__"]` is
 * an object — none of them `undefined`. A `!== undefined` check therefore PASSES for all of
 * them, and the call returns `false` only because `fn >= 0` coerces to `NaN >= 0`. That is the
 * right answer by ACCIDENT rather than by design, in the one function whose entire job is to
 * fail closed. `Object.hasOwn` asks the question the comment always claimed to be asking.
 */
export function hasRole(role: string, minimum: Role): boolean {
  if (!Object.hasOwn(RANK, role)) return false;
  return RANK[role as Role] >= RANK[minimum];
}

/** Narrowing guard for values arriving from the database as plain TEXT. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
