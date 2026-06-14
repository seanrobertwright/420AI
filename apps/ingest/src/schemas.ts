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

/** ?type=&scopeId= for the report history list (both optional filters). */
export const listReportsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    scopeId: { type: "string" },
  },
} as const;
