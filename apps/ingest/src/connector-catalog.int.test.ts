import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createDb } from "@420ai/db";
import { canonicalizeCatalog, type CatalogContent } from "@420ai/shared";
import type { ConnectorCatalogPayload } from "@420ai/shared";
import { buildApp } from "./app.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const ADMIN = "test-admin";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in connector-catalog tests", "unavailable");
  },
};

// Ephemeral signing keypair: the test signs with the private half and injects the
// public half into buildApp — the bundled CONNECTOR_CATALOG_PUBLIC_KEY's private key is
// NOT in CI (offline-only). Mirrors catalog.int.test.ts (pricing).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const EPHEMERAL_PUB = publicKey.export({ type: "spki", format: "pem" }).toString();
const EPHEMERAL_PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const PAYLOAD: ConnectorCatalogPayload = {
  connectors: [
    {
      id: "claude-code",
      displayName: "Claude Code (catalog)",
      watchGlobs: ["/home/.claude/projects/*/*.jsonl"],
      fidelity: { requiredPermissions: ["Read Claude Code transcripts (catalog-sourced)"] },
    },
    {
      id: "custom-syslog",
      def: { id: "custom-syslog", watchGlobs: ["/var/log/syslog"], format: "jsonl" },
    },
  ],
};

const CONTENT: CatalogContent<ConnectorCatalogPayload> = {
  version: "m12-connector-catalog-v2",
  payload: PAYLOAD,
};

function sign(content: CatalogContent<ConnectorCatalogPayload>): string {
  return cryptoSign(
    null,
    Buffer.from(canonicalizeCatalog(content), "utf8"),
    EPHEMERAL_PRIV,
  ).toString("base64");
}

describe.skipIf(!TEST_URL)("connector-catalog API (HTTP e2e via inject) — M12 12.7c", () => {
  let dbh: ReturnType<typeof createDb>;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(TEST_URL!);
    app = buildApp({
      db: dbh.db,
      adminToken: ADMIN,
      analysisProvider: stubProvider,
      connectorCatalogPublicKey: EPHEMERAL_PUB,
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE connector_catalogs, raw_source_records, events, ingest_tokens, pairing_codes, machines, users RESTART IDENTITY CASCADE`,
    );
  });

  // --- harness ---

  async function createCode(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing-codes",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json().code as string;
  }

  async function pair(code: string): Promise<{ token: string; machineId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, machine: { name: "test-machine" } },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  function adminPost(url: string, payload?: unknown) {
    if (payload === undefined) {
      return app.inject({ method: "POST", url, headers: { authorization: `Bearer ${ADMIN}` } });
    }
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: payload as object,
    });
  }

  function adminGet(url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ADMIN}` } });
  }

  it("rejects an upload with a tampered signature (400) and a missing admin bearer (401)", async () => {
    const good = sign(CONTENT);
    // no admin bearer
    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/connector-catalog",
      headers: { "content-type": "application/json" },
      payload: { ...CONTENT, signature: good },
    });
    expect(noAuth.statusCode).toBe(401);

    // tampered payload, original signature → verify fails → 400
    const tampered = await adminPost("/v1/connector-catalog", {
      version: CONTENT.version,
      payload: { connectors: [{ id: "claude-code", watchGlobs: ["/evil/**"] }] },
      signature: good,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error).toBe("signature verification failed");
  });

  it("uploads pending → lists → approves → machine-authed active returns the payload", async () => {
    const { token } = await pair(await createCode());

    // (1) upload a validly-signed catalog → 200 pending
    const up = await adminPost("/v1/connector-catalog", { ...CONTENT, signature: sign(CONTENT) });
    expect(up.statusCode).toBe(200);
    const id = up.json().id as string;
    expect(up.json().status).toBe("pending");

    // (2) it lists (admin)
    const list = await adminGet("/v1/connector-catalog");
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).some((r) => r.id === id)).toBe(true);

    // (3) while pending, the machine-authed active endpoint returns 204 (nothing active)
    const activePending = await app.inject({
      method: "GET",
      url: "/v1/connector-catalog/active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(activePending.statusCode).toBe(204);

    // (4) approve → active
    const approve = await adminPost(`/v1/connector-catalog/${id}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("active");

    // (5) the collector (machine token) pulls the active catalog
    const active = await app.inject({
      method: "GET",
      url: "/v1/connector-catalog/active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(active.statusCode).toBe(200);
    const body = active.json() as {
      version: string;
      payload: ConnectorCatalogPayload;
      signature: string;
    };
    expect(body.version).toBe("m12-connector-catalog-v2");
    expect(body.signature).toBe(sign(CONTENT)); // ships for collector re-verify
    expect(body.payload.connectors.map((c) => c.id)).toEqual(["claude-code", "custom-syslog"]);
    expect(body.payload.connectors[0]?.watchGlobs).toEqual(["/home/.claude/projects/*/*.jsonl"]);
  });

  it("the active endpoint is machine-authed: an invalid token → 401", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/v1/connector-catalog/active",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("approve/reject guard the id: malformed → 404, unknown uuid → 404", async () => {
    expect((await adminPost("/v1/connector-catalog/not-a-uuid/approve")).statusCode).toBe(404);
    expect(
      (await adminPost("/v1/connector-catalog/00000000-0000-4000-8000-000000000000/approve"))
        .statusCode,
    ).toBe(404);
    expect((await adminPost("/v1/connector-catalog/not-a-uuid/reject")).statusCode).toBe(404);
  });

  it("rejects a pending connector catalog", async () => {
    const up = await adminPost("/v1/connector-catalog", { ...CONTENT, signature: sign(CONTENT) });
    const id = up.json().id as string;
    const rej = await adminPost(`/v1/connector-catalog/${id}/reject`);
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe("rejected");
  });
});
