import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySessionEdge } from "./session.js";

/**
 * Interop test (the executable form of PRE-FLIGHT Spike 3): a token signed with node:crypto
 * EXACTLY as ingest's signSession does must verify under the dashboard's Edge `crypto.subtle`
 * verifier. This is the load-bearing proof that an ingest-issued cookie is accepted by the
 * middleware. Both createHmac and crypto.subtle exist in the vitest/node test env.
 */
const SECRET = "shared-session-secret";

/** Replicate ingest's signSession (node:crypto) inline — same format as apps/ingest/src/session.ts. */
function nodeSign(sub: string, secret: string, ttlSec: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const body = Buffer.from(JSON.stringify({ sub, iat, exp })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

describe("verifySessionEdge (Node-sign → Edge-verify interop)", () => {
  it("accepts a node:crypto-signed token and returns its payload", async () => {
    const token = nodeSign("admin@test.local", SECRET, 3600);
    const payload = await verifySessionEdge(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("admin@test.local");
    expect(typeof payload!.exp).toBe("number");
  });

  it("rejects a tampered token", async () => {
    const token = nodeSign("admin@test.local", SECRET, 3600);
    expect(await verifySessionEdge(token + "x", SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = nodeSign("admin@test.local", SECRET, 3600);
    expect(await verifySessionEdge(token, "wrong-secret")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = nodeSign("admin@test.local", SECRET, -1);
    expect(await verifySessionEdge(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token (no dot)", async () => {
    expect(await verifySessionEdge("not-a-token", SECRET)).toBeNull();
  });

  it("returns null (does not throw) for a valid-MAC token whose payload is JSON null", async () => {
    const body = Buffer.from("null").toString("base64url");
    const mac = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(await verifySessionEdge(`${body}.${mac}`, SECRET)).toBeNull();
  });
});
