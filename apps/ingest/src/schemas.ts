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

/** POST body for a project cost report — `type` defaults to the only project type; `bucket` defaults day. */
export const generateProjectReportBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["project.cost_over_time"] },
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

/** ?type=&scopeId= for the report history list (both optional filters). */
export const listReportsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    scopeId: { type: "string" },
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
