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
