import {
  FRICTIONS,
  FOLLOW_UP_MAX_LENGTH,
  INTENT_MAX_LENGTH,
  LABEL_CONFIDENCE,
  LABEL_STATUSES,
  OUTCOMES,
  TASK_TYPES,
} from "@420ai/shared";

/**
 * JSON schemas for request bodies. Fastify validates + coerces natively from
 * these (no zod) — a malformed body is rejected with 400 before the handler
 * runs. We are strict on identity/metric fields and permissive on the arbitrary
 * `events[].payload` (it is opaque JSON the server encrypts as-is).
 */

export const pairingCodeBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string" },
    userId: { type: "string" },
  },
} as const;

// --- M12 12.3 admin login. Both fields REQUIRED + minLength:1 so a malformed body
// is a 400 (via the err.validation branch in app.ts) before the handler runs. ---

/** POST /v1/auth/login body — the single admin's email + password. */
export const loginBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
  },
} as const;

export const pairBodySchema = {
  type: "object",
  required: ["code", "machine"],
  additionalProperties: false,
  properties: {
    code: { type: "string", minLength: 1 },
    machine: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        os: { type: "string" },
        hostname: { type: "string" },
      },
    },
  },
} as const;

const rawRecordSchema = {
  type: "object",
  required: ["sourceConnector", "sessionId", "sourceRecordId", "payload"],
  properties: {
    sourceConnector: { type: "string" },
    sessionId: { type: "string" },
    sourceRecordId: { type: "string" },
    payload: { type: "string" },
    ingestedAt: { type: "string" },
  },
} as const;

const eventSchema = {
  type: "object",
  required: [
    "fingerprint",
    "sourceConnector",
    "parserVersion",
    "rawRecordId",
    "eventIndex",
    "eventType",
    "sessionId",
    "ts",
  ],
  properties: {
    fingerprint: { type: "string" },
    sourceConnector: { type: "string" },
    parserVersion: { type: "string" },
    catalogVersion: { type: "string" }, // optional; NOT in `required` (back-compat)
    rawRecordId: { type: "string" },
    eventIndex: { type: "integer" },
    eventType: { type: "string" },
    sessionId: { type: "string" },
    projectPath: { type: "string" },
    gitBranch: { type: "string" },
    model: { type: "string" },
    ts: { type: "string" },
    tokens: { type: "object" },
    cost: { type: "object" },
    // arbitrary JSON — accept anything (including absent)
    payload: {},
  },
} as const;

export const ingestBodySchema = {
  type: "object",
  required: ["records", "events"],
  additionalProperties: false,
  properties: {
    records: { type: "array", items: rawRecordSchema },
    events: { type: "array", items: eventSchema },
  },
} as const;

// --- M9 collector heartbeat body ---

/** POST /v1/heartbeat body — the collector's sync backlog + version (HeartbeatRequest). */
export const heartbeatBodySchema = {
  type: "object",
  required: ["queuePending", "queueInflight", "collectorVersion"],
  additionalProperties: false,
  properties: {
    queuePending: { type: "integer", minimum: 0 },
    queueInflight: { type: "integer", minimum: 0 },
    collectorVersion: { type: "string", minLength: 1 },
    // M12 12.6 archive.unreachable signal — optional (NOT in required) so an older collector
    // omits it; additionalProperties:false means it MUST be declared or a sender 400s.
    consecutiveSyncFailures: { type: "integer", minimum: 0 },
  },
} as const;

// --- M5 discovery / project mapping bodies ---

const discoveredWorkspaceSchema = {
  type: "object",
  required: ["sourceConnector", "projectKey", "rootPath"],
  additionalProperties: false,
  properties: {
    sourceConnector: { type: "string", minLength: 1 },
    projectKey: { type: "string", minLength: 1 },
    rootPath: { type: "string", minLength: 1 },
    gitRemote: { type: "string", minLength: 1 },
    gitBranch: { type: "string", minLength: 1 },
    sessionCount: { type: "integer", minimum: 0 },
  },
} as const;

export const discoverBodySchema = {
  type: "object",
  required: ["workspaces"],
  additionalProperties: false,
  properties: {
    workspaces: { type: "array", items: discoveredWorkspaceSchema },
  },
} as const;

export const createProjectBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    gitRemote: { type: "string", minLength: 1 },
  },
} as const;

export const patchProjectBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
  },
} as const;

// --- M13 13.4 list pagination. Fastify coerces the querystring strings to
// integers; out-of-range values are a 400 via the err.validation branch. An
// OMITTED limit returns the full list (several consumers — project-detail
// existence authority, workspace-remap picker, collector mapping — need
// completeness); the paged dashboard lists pass an explicit limit. ---

/** ?limit=1..200&offset=0.. for GET /v1/projects (omitted → full list). */
export const listProjectsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

export const patchWorkspaceBodySchema = {
  type: "object",
  required: ["projectId"],
  additionalProperties: false,
  properties: {
    projectId: { type: "string", minLength: 1 },
  },
} as const;

// --- M6 projection querystrings ---

/** ?bucket=day|week for the usage-over-time projection (defaults to day in the handler). */
export const usageOverTimeQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bucket: { type: "string", enum: ["day", "week"] },
  },
} as const;

// --- M7 report generation bodies + history querystring ---

/**
 * POST body for a project report — `type` defaults to `project.cost_over_time` (byte-for-byte
 * preserving pre-13.2 behavior). M13 13.2 widens the enum from one type to six; `bucket` is
 * honored by the two types that bucket a time series (cost_over_time, trend_anomalies) and
 * ignored by the rest.
 */
export const generateProjectReportBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "project.cost_over_time",
        "project.tool_model_comparison",
        "project.failed_tool_calls",
        "project.context_waste",
        "project.efficiency",
        "project.trend_anomalies",
      ],
    },
    bucket: { type: "string", enum: ["day", "week"] },
  },
} as const;

/** POST body for a session autopsy — `type` defaults to the only session type. */
export const generateSessionReportBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["session.autopsy"] },
  },
} as const;

// --- M8 AI interpretation generation bodies (fetch/list reuse listReportsQuerySchema) ---

/** POST body for a session AI interpretation — `type` defaults to the only session AI type. */
export const generateSessionInterpretationBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["session.ai_interpretation"] },
  },
} as const;

/** POST body for a project AI interpretation — `type` defaults to the only project AI type. */
export const generateProjectInterpretationBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["project.ai_interpretation"] },
  },
} as const;

/** ?type=&scopeId=[&limit=1..200][&offset=0..] for the report history list (13.4 adds paging). */
export const listReportsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    scopeId: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

// --- M10 export querystrings (PRD §22). `format` is REQUIRED so a missing/invalid
// value is a 400 via the err.validation branch in app.ts; filter fields stay
// permissive strings (no coercion). ---

/** ?format=json|jsonl|csv (+ optional project/session/connector/time filters). */
export const exportEventsQuerySchema = {
  type: "object",
  required: ["format"],
  additionalProperties: false,
  properties: {
    format: { type: "string", enum: ["json", "jsonl", "csv", "parquet"] },
    projectId: { type: "string" },
    sessionId: { type: "string" },
    connector: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
  },
} as const;

/** ?format=md|json for a single report-artifact export. */
export const exportReportQuerySchema = {
  type: "object",
  required: ["format"],
  additionalProperties: false,
  properties: {
    format: { type: "string", enum: ["md", "json"] },
  },
} as const;

/** ?format=md|json|jsonl for a decrypt-for-render session-transcript export. */
export const exportTranscriptQuerySchema = {
  type: "object",
  required: ["format"],
  additionalProperties: false,
  properties: {
    format: { type: "string", enum: ["md", "json", "jsonl"] },
  },
} as const;

// --- M10 git capture + attribution bodies ---

/** One changed file in a captured commit (numstat row). */
const gitFileChangeSchema = {
  type: "object",
  required: ["path", "status", "insertions", "deletions"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["added", "modified", "deleted", "renamed"] },
    insertions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
  },
} as const;

/** One captured commit. Core identity/metric fields required; `message` may be empty; `gitBranch` optional. */
const gitCommitSchema = {
  type: "object",
  required: [
    "commitSha",
    "repoRootPath",
    "authorName",
    "authorEmail",
    "authoredAt",
    "committedAt",
    "message",
    "parents",
    "isRevert",
    "filesChanged",
    "insertions",
    "deletions",
    "files",
  ],
  additionalProperties: false,
  properties: {
    commitSha: { type: "string", minLength: 1 },
    repoRootPath: { type: "string", minLength: 1 },
    gitBranch: { type: "string" },
    authorName: { type: "string" },
    authorEmail: { type: "string" },
    authoredAt: { type: "string", minLength: 1 },
    committedAt: { type: "string" },
    message: { type: "string" }, // may be "" (empty body is normal)
    parents: { type: "array", items: { type: "string" } },
    isRevert: { type: "boolean" },
    filesChanged: { type: "integer", minimum: 0 },
    insertions: { type: "integer", minimum: 0 },
    deletions: { type: "integer", minimum: 0 },
    files: { type: "array", items: gitFileChangeSchema },
  },
} as const;

/** POST /v1/git body — a batch of captured commits (machine-authed; idempotent by SHA). */
export const gitCaptureBodySchema = {
  type: "object",
  required: ["commits"],
  additionalProperties: false,
  properties: {
    commits: { type: "array", items: gitCommitSchema },
  },
} as const;

/** POST /v1/projects/:id/git/suggest body — optional `sessionId` to scope to one session. */
export const suggestGitBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", minLength: 1 },
  },
} as const;

/** POST /v1/sessions/:sessionId/git-links body — link a session to a commit by SHA. */
export const manualLinkBodySchema = {
  type: "object",
  required: ["commitSha"],
  additionalProperties: false,
  properties: {
    commitSha: { type: "string", minLength: 1 },
  },
} as const;

/** PATCH /v1/git-links/:id body — confirm or reject a suggested link. */
export const patchGitLinkBodySchema = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["confirmed", "rejected"] },
  },
} as const;

// --- M10 3d signed catalog upload (PRD §10.4/§18). `payload` stays permissive
// (`type:"object"`) — the ed25519 signature is the real integrity check, not the
// JSON schema; arbitrary nested model→rates ride through. ---

/** POST /v1/catalog body — a signed pricing-catalog update (version + payload + base64 ed25519 signature). */
export const catalogUploadBodySchema = {
  type: "object",
  required: ["version", "payload", "signature"],
  additionalProperties: false,
  properties: {
    version: { type: "string", minLength: 1 },
    payload: { type: "object" },
    signature: { type: "string", minLength: 1 },
  },
} as const;

// --- M12 12.7c signed connector-catalog upload (PRD §10.4). Same shape as the pricing
// upload — `payload` stays permissive (`type:"object"`); the ed25519 signature is the
// real integrity check, not the JSON schema. ---

/** POST /v1/connector-catalog body — a signed connector-catalog update (version + payload + base64 ed25519 signature). */
export const connectorCatalogUploadBodySchema = {
  type: "object",
  required: ["version", "payload", "signature"],
  additionalProperties: false,
  properties: {
    version: { type: "string", minLength: 1 },
    payload: { type: "object" },
    signature: { type: "string", minLength: 1 },
  },
} as const;

// --- M12 §21 search querystring. `q` is REQUIRED + `minLength:1` so an empty
// query is a 400 (via the err.validation branch) before the handler runs;
// `type`/`projectId`/`limit` are optional filters. ---

/** ?q=…[&type=session|report|project|event][&projectId=…][&limit=1..100][&offset=0..] for GET /v1/search. */
export const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    q: { type: "string", minLength: 1, maxLength: 256 },
    type: { type: "string", enum: ["session", "report", "project", "event"] },
    projectId: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

// --- M15 15.5 identity core ---
//
// Every schema below carries `additionalProperties: false` and lists each field in `required`, so a
// missing or unexpected field is a 400 via app.ts's `err.validation` branch BEFORE the handler
// runs — which matters more here than anywhere else, because these bodies carry credentials.
//
// The `role` enums are the literal four strings from `ROLES` in `packages/shared/src/roles.ts:11`.
// A Fastify JSON-schema enum cannot reference a TypeScript const, so THEY ARE KEPT IN SYNC BY HAND:
// adding a fifth rung means editing `ROLES`, `RANK`, and both enums below.
//
// `password` is `minLength: 12` on every credential-SETTING route (accept-invite, signup, reset
// confirm, change) but `minLength: 1` on LOGIN — login must keep accepting an ADMIN_PASSWORD seeded
// before this rule existed, whereas a password chosen through one of these routes is new and can be
// held to the higher bar.
const MIN_NEW_PASSWORD_LENGTH = 12;

/** POST /v1/members/invite body — the invitee's email + the rung to grant them. */
export const inviteMemberBodySchema = {
  type: "object",
  required: ["email", "role"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    role: { type: "string", enum: ["viewer", "member", "admin", "owner"] },
  },
} as const;

/** PATCH /v1/members/:userId body — the member's new rung. */
export const patchMemberRoleBodySchema = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: ["viewer", "member", "admin", "owner"] },
  },
} as const;

/**
 * PATCH /v1/org body — the organization's new display name (M15 15.10).
 *
 * BOUNDED at 200, matching the file's habit of bounding every free-text field at the edge. The
 * column is unbounded `text`, and a 10 KB name would land in THREE RENDERED SURFACES — the
 * Settings `<OrgCard/>`, the `/team` page header, and the PUBLIC invite page's "Join {orgName}"
 * heading, which is shown to a visitor with no session — as well as in the break-glass
 * operator's `select * from audit_events`. `minLength: 1` because an empty name renders as a
 * blank card with no way back — the rename endpoint would have to be re-driven by hand to fix it.
 */
export const patchOrgBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

/** POST /v1/auth/invites/accept body — the invite token + the password the invitee chooses. */
export const acceptInviteBodySchema = {
  type: "object",
  required: ["token", "password"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: MIN_NEW_PASSWORD_LENGTH, maxLength: 256 },
  },
} as const;

/** POST /v1/auth/signup body — gated behind SELF_SIGNUP_ENABLED (D-15.5-5), off by default. */
export const signupBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: MIN_NEW_PASSWORD_LENGTH, maxLength: 256 },
  },
} as const;

/** POST /v1/auth/sso/:provider/start body — optional, carries only the invite being accepted. */
export const ssoStartBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { inviteToken: { type: "string", minLength: 8, maxLength: 256 } },
} as const;

/**
 * POST /v1/auth/sso/:provider/callback (and .../link) body. NOTE what is ABSENT: `redirectUri`.
 * Ingest derives it from APP_BASE_URL so a caller can never steer the exchange (D-15.7-6).
 */
export const ssoCallbackBodySchema = {
  type: "object",
  required: ["code"],
  additionalProperties: false,
  properties: {
    code: { type: "string", minLength: 1, maxLength: 2048 },
    codeVerifier: { type: "string", minLength: 32, maxLength: 128 },
    inviteToken: { type: "string", minLength: 8, maxLength: 256 },
  },
} as const;

/** POST /v1/auth/password-reset body — the address to mail a reset link to (always 202). */
export const passwordResetRequestBodySchema = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
  },
} as const;

/** POST /v1/auth/password-reset/confirm body — the mailed token + the new password. */
export const passwordResetConfirmBodySchema = {
  type: "object",
  required: ["token", "password"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: MIN_NEW_PASSWORD_LENGTH, maxLength: 256 },
  },
} as const;

/** POST /v1/auth/password body — session-gated change of one's OWN password. */
export const changePasswordBodySchema = {
  type: "object",
  required: ["currentPassword", "newPassword"],
  additionalProperties: false,
  properties: {
    currentPassword: { type: "string", minLength: 1 },
    newPassword: { type: "string", minLength: MIN_NEW_PASSWORD_LENGTH, maxLength: 256 },
  },
} as const;

// --- M15 15.8 MFA (D-M15-5) ---

/**
 * POST /v1/auth/mfa/enroll/confirm, /disable, /recovery-codes body — a single presented factor.
 *
 * ONE field for BOTH credential kinds, deliberately: the route tries the TOTP shape first and falls
 * through to the recovery-code hash lookup (`verifyTotp` rejects on `/^\d{6}$/` before any HMAC), so
 * a `kind` discriminator would be a second source of truth the server would have to distrust anyway.
 * Hence the wide bounds — 6 for a TOTP code, up to 64 for a base64url recovery code.
 */
export const mfaCodeBodySchema = {
  type: "object",
  required: ["code"],
  additionalProperties: false,
  properties: {
    code: { type: "string", minLength: 6, maxLength: 64 },
  },
} as const;

/**
 * POST /v1/auth/mfa/enroll body — the RE-AUTHENTICATION for arming a second factor (D-15.8-16).
 *
 * `currentPassword` is OPTIONAL in the schema and REQUIRED by the route for any account that has a
 * password. It cannot be required here, because an SSO-only account (`password_hash IS NULL`) has
 * none to send and re-proves with session recency instead — a distinction ajv cannot see, since it
 * depends on a database row. The route makes it, and answers 401 either way.
 */
export const mfaEnrollBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    currentPassword: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

/**
 * POST /v1/auth/mfa/verify body — the challenge issued by the login, plus the factor.
 *
 * `challenge` is permissive on length on purpose: it is `base64url(payload).base64url(mac)`, ~200
 * characters today, and a payload change must not turn into a 400 nobody can diagnose. 1024 is a
 * sanity bound, not a validation.
 */
export const mfaVerifyBodySchema = {
  type: "object",
  required: ["challenge", "code"],
  additionalProperties: false,
  properties: {
    challenge: { type: "string", minLength: 1, maxLength: 1024 },
    code: { type: "string", minLength: 6, maxLength: 64 },
  },
} as const;

/**
 * M15 15.9 — POST /v1/auth/api-keys body (D-M15-7).
 *
 * `name` is REQUIRED and is the only required field: a key you cannot recognise in the list is a
 * key you will never dare revoke, which defeats the point of the tier. It is free text and never a
 * security decision.
 *
 * `role` is OPTIONAL, and its absence MEANS SOMETHING — "inherit the owner's membership role
 * exactly" (D-15.9-4), which is what `ADMIN_TOKEN` effectively does today and is what makes the
 * desktop app's migration behaviour-preserving. The enum mirrors `inviteMemberBodySchema`; the
 * CEILING (you may not mint above your own rung) is a route-layer check, since ajv cannot see the
 * caller's principal.
 *
 * `expiresInDays` is OPTIONAL and its absence means NEVER EXPIRES (D-15.9-8). Taken as a duration
 * rather than an absolute timestamp so the server owns the clock — a client-supplied `expiresAt`
 * would let a skewed or hostile client mint a key that is already expired (harmless) or dated to
 * the year 3000 (not). 3650 days is a sanity bound, not a policy.
 *
 * `currentPassword` is OPTIONAL for the same reason it is on `mfaEnrollBodySchema`: minting requires
 * re-authentication (D-15.9-6), but an SSO-only account has no password to send and re-proves with
 * session recency instead — a distinction ajv cannot make, because it depends on a database row.
 * The route makes it, and answers 401 either way.
 */
export const createApiKeyBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    role: { type: "string", enum: ["viewer", "member", "admin", "owner"] },
    expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
    currentPassword: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

// --- M16 16.1 the §4.3 OUTCOME LABEL surface (research plan §4.3 / §7 P0.2). ---
//
// THESE ENUMS ARE BUILT FROM THE SHARED ARRAYS, unlike the `role` enums above which this file keeps
// in sync by hand. The difference is deliberate and worth stating, because the next person adding a
// closed set here has to pick one: `ROLES` has FOUR members that have not changed since 15.4 and
// are unlikely to, whereas the §4.3 sets are owned by a research document expected to evolve during
// the 24-week period. A hand-copied enum there would reject a value the rest of the system
// considers legal, and the symptom would be a 400 on a tray the operator had just used — diagnosed
// at the HTTP edge, far from the array somebody edited. Spreading (`[...TASK_TYPES]`) is what makes
// `@420ai/shared` the single source it claims to be.
//
// EVERY FREE-TEXT FIELD IS BOUNDED AT THE EDGE, per this file's habit: the columns are unbounded
// `text`, and a 10 KB `intent` would land in 16.2's dashboard table, in every export, and in 16.4's
// audit report. `intent`'s 200 is §4.3's own limit; `followUpCommitOrPr`'s 500 is this repo's.

/**
 * POST /v1/sessions/:sessionId/label body.
 *
 * ONLY `status` is required, because A SKIP IS A ROW (D-16.1-2) and carries none of the six §4.3
 * fields. The required-when-`labeled` shape is deliberately NOT expressed here: ajv could do it with
 * `if/then`, but the repository's discriminated union already makes an incomplete `labeled` create a
 * compile error at every internal call site, and the route checks it explicitly so the 400 NAMES the
 * missing field instead of emitting an opaque if/then validation error.
 */
export const createOutcomeLabelBodySchema = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...LABEL_STATUSES] },
    taskType: { type: "string", enum: [...TASK_TYPES] },
    intent: { type: "string", minLength: 1, maxLength: INTENT_MAX_LENGTH },
    outcome: { type: "string", enum: [...OUTCOMES] },
    qualityRating: { type: "integer", minimum: 1, maximum: 5 },
    primaryFriction: { type: "string", enum: [...FRICTIONS] },
    followUpCommitOrPr: { type: "string", minLength: 1, maxLength: FOLLOW_UP_MAX_LENGTH },
    confidence: { type: "string", enum: [...LABEL_CONFIDENCE] },
  },
} as const;

/**
 * PATCH /v1/sessions/:sessionId/label body — the same properties with NOTHING required, plus
 * `minProperties: 1`.
 *
 * That last constraint is the point: an empty PATCH would otherwise be a no-op that still bumped
 * `revision` and appended a snapshot identical to its predecessor, quietly polluting the one record
 * 16.4 reads as evidence of what changed. A 400 is the honest answer.
 */
export const patchOutcomeLabelBodySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...LABEL_STATUSES] },
    taskType: { type: "string", enum: [...TASK_TYPES] },
    intent: { type: "string", minLength: 1, maxLength: INTENT_MAX_LENGTH },
    outcome: { type: "string", enum: [...OUTCOMES] },
    qualityRating: { type: "integer", minimum: 1, maximum: 5 },
    primaryFriction: { type: "string", enum: [...FRICTIONS] },
    // THE TWO OPTIONAL §4.3 FIELDS ACCEPT `null`, and only these two. The repository has always
    // implemented null-means-CLEAR, but every field here was typed `string`, so the capability was
    // documented in `PatchOutcomeLabelInput` and unreachable from the only caller — a contract
    // describing behaviour the system would 400 on. `enum` must list `null` alongside the members,
    // because ajv checks `enum` membership independently of `type`.
    //
    // The five REQUIRED-when-`labeled` fields deliberately stay non-nullable: clearing `outcome` on
    // a row that still says `labeled` is the incoherent state `assertLabelShape` exists to refuse.
    // Retract a judgement by patching `status` to `skipped`, which clears all seven at once.
    followUpCommitOrPr: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: FOLLOW_UP_MAX_LENGTH,
    },
    confidence: { type: ["string", "null"], enum: [...LABEL_CONFIDENCE, null] },
  },
} as const;

/** ?status=&outcome=&taskType=&sessionId=[&limit=1..200][&offset=0..] for GET /v1/labels. */
export const listOutcomeLabelsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...LABEL_STATUSES] },
    outcome: { type: "string", enum: [...OUTCOMES] },
    taskType: { type: "string", enum: [...TASK_TYPES] },
    sessionId: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * ?format=json|jsonl|csv (+ the same filters) for GET /v1/labels/export. `format` is REQUIRED so a
 * missing or invalid value is a 400 via app.ts's `err.validation` branch, matching the three M10
 * export querystrings. No `md` and no `parquet`: a label list is tabular, not a document, and
 * Parquet is deliberately events-only (12.8).
 */
export const exportOutcomeLabelsQuerySchema = {
  type: "object",
  required: ["format"],
  additionalProperties: false,
  properties: {
    format: { type: "string", enum: ["json", "jsonl", "csv"] },
    status: { type: "string", enum: [...LABEL_STATUSES] },
    outcome: { type: "string", enum: [...OUTCOMES] },
    taskType: { type: "string", enum: [...TASK_TYPES] },
    sessionId: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;
