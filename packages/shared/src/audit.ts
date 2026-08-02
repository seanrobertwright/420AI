/**
 * M15 15.10 — the closed set of AUDITED ACTIONS (D-15.10-2/3/4).
 *
 * TEXT, not a pg enum, matching `memberships.role` (schema.ts:87), `ROLES` and every other closed
 * set in this repo — adding a value is a code change, not a migration. The `action` column on
 * `audit_events` carries NO CHECK constraint, so THIS GUARD IS THE ENFORCEMENT: the repository
 * takes an `AuditAction`, which makes a typo a compile error rather than an unqueryable string in
 * the one table the application can never `UPDATE`.
 *
 * The spelling is `<subject>.<verb_past_tense>`, asserted by `audit.test.ts`. Past tense because an
 * audit row records something that HAPPENED — the write is in the same transaction as the action it
 * describes (D-15.10-3), so by the time anyone can read it, it is history.
 *
 * THE BOUNDARY, stated so it can actually be APPLIED to a new action. An act belongs here when
 * EITHER of these is true:
 *
 *   1. it changes ANOTHER principal's standing (invite, join, role change, removal, MFA reset), or
 *   2. it mints or destroys a LONG-LIVED CREDENTIAL that outlives the session which created it.
 *
 * The second clause is why the three `api_key.*` actions are audited even though key management is
 * self-service and the actor IS the target. An earlier version of this comment gave only the first
 * clause, which contradicted the list immediately below it — and a criterion that excludes entries
 * already in the set cannot be used by the next person deciding whether a new action belongs.
 *
 * WHAT IS DELIBERATELY EXCLUDED, on that same rule:
 *
 *   - LOGINS AND LOGIN FAILURES. `ingest_auth_failures` already records the failures, which is the
 *     half with security value; recording every SUCCESS would turn a record of privileged acts into
 *     a traffic log and bury the ten entries below under one row per page view.
 *   - PASSWORD CHANGE, MFA ENROL/DISABLE, SESSION REVOKE. Neither clause applies: they alter only
 *     the account holder's own LIVE authentication, which is already visible to them in `/settings`,
 *     and none produces a credential that outlives the session. `member.mfa_reset` IS audited
 *     precisely because it is the admin-initiated variant — someone else acting on your credentials,
 *     which is clause 1.
 */
export const AUDIT_ACTIONS = [
  "api_key.minted",
  "api_key.revoked",
  "api_key.revoked_all",
  "member.invite_revoked",
  "member.invited",
  "member.joined",
  "member.mfa_reset",
  "member.removed",
  "member.role_changed",
  "org.renamed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Narrowing guard for an action arriving as a bare string.
 *
 * NO CALLER TODAY, and that is expected rather than an oversight: D-15.10-4 means there is no read
 * path, so no string-shaped action arrives at runtime for this to narrow. The ENFORCEMENT is
 * `recordAuditEvent`'s `AuditAction` parameter type, which makes a typo a compile error. This exists
 * for the future reader and for an importer that ever does parse one back (a break-glass tool, an
 * export) — kept deliberately, unlike `isRole`, which genuinely is called (`apps/ingest/src/auth.ts`).
 */
export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
