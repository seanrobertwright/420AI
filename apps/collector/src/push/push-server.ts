import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { toRawRecordPayload, toEventPayload } from "@420ai/shared";
import type { Connector } from "../connectors/connector.js";
import type { QueueStore } from "../queue/queue-store.js";

/**
 * The `push` capture-mode receiver (M14 slice 14.7): a `127.0.0.1`-bound, token-authed
 * `node:http` server that accepts conversation JSON pushed by the browser extension,
 * routes it through a push-capable connector's existing `parse` contract, and enqueues
 * the result onto the SAME durable queue the watcher/poll loops feed. No new dependency
 * (`node:http`/`node:crypto` are built-in), no queue/sync/ingest/fingerprint change.
 *
 * NAMING: this is the `captureMode:"push"` RECEIVER. It is UNRELATED to the existing
 * `collector push <file>` CLI subcommand (`runPush` in cli.ts — a one-shot file→ingest
 * uploader). Do not conflate them.
 *
 * Library file: no direct stdout — it talks via the injected `log` callback (the engine
 * wires it). Best-effort like `pollLoop`/`gitSweepLoop`: a bad request degrades to a 4xx,
 * a port collision degrades to a logged no-op — neither ever throws out of capture.
 */

/** Default receiver port (also the `http://127.0.0.1:42017/*` extension host-permission). */
export const DEFAULT_PUSH_PORT = 42017;

/** Mirror the ingest server's 16 MiB `bodyLimit` (apps/ingest/src/app.ts) — over → 413. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The receiver's single route. */
const PUSH_PATH = "/v1/push";

/**
 * Defensive CORS: an extension BACKGROUND fetch to a `host_permissions` origin bypasses
 * page CORS entirely (no preflight), so these headers are belt-and-suspenders for a
 * hypothetical MAIN-world content-script POST. `*` is safe: the token gates every write.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
} as const;

export interface PushServerOptions {
  /** The enabled+approved push-capable connectors (the engine passes the filtered set). */
  connectors: Connector[];
  /** The durable queue the parsed records/events are enqueued onto (dedups by content hash). */
  queue: QueueStore;
  /** The shared bearer secret every POST must present (from `loadOrCreatePushToken`). */
  token: string;
  /** Listen port (default `DEFAULT_PUSH_PORT`; tests pass 0 for an ephemeral port). */
  port?: number;
  /** Bind host (default `127.0.0.1` — NEVER `0.0.0.0`; the receiver is not LAN-exposed). */
  host?: string;
  /** Progress logger (the engine's callback; library files never touch stdout directly). */
  log: (msg: string) => void;
  /** Called with the actually-bound port once listening (tests resolve the ephemeral port). */
  onListen?: (port: number) => void;
}

/** Internal handler context — the options plus a connector-by-id lookup. */
interface HandlerContext extends PushServerOptions {
  byId: Map<string, Connector>;
}

/** Constant-time bearer check. Length-mismatch short-circuits (timingSafeEqual needs equal length). */
function authOk(header: string | undefined, token: string): boolean {
  // Defense-in-depth: an empty configured token would make `Bearer ` (empty) auth via a
  // zero-length timingSafeEqual — reject outright. Not reachable in prod (the token is always
  // randomBytes), but never leave the receiver open on a misconfiguration.
  if (token.length === 0) return false;
  const prefix = "Bearer ";
  if (typeof header !== "string" || !header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Write a small JSON response (best-effort — never throws if the socket is already gone). */
function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * Handle one request. NEVER throws — every failure mode maps to a status code so the
 * server can never crash on a malformed/hostile request (the ingest-hardening posture).
 */
function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): void {
  try {
    // Swallow response/request socket errors (armed BEFORE any write): a client that
    // disconnects mid-response — or is RST after the 413 `req.destroy()` below — otherwise
    // surfaces an unhandled 'error' that would crash the whole receiver. The record is
    // already enqueued locally by then, so a failed response write is harmless to capture.
    res.on("error", () => {});
    req.on("error", () => {}); // also caught below for the in-flight-body case

    // Defensive preflight support.
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== PUSH_PATH) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!authOk(req.headers.authorization, ctx.token)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    // Stream + bound the body (16 MiB). A too-large body is rejected mid-stream (413) and
    // the connection destroyed, so a hostile client can't exhaust memory.
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        json(res, 413, { error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      json(res, 400, { error: "request stream error" });
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (
          !body ||
          typeof body !== "object" ||
          typeof (body as { connector?: unknown }).connector !== "string" ||
          !Array.isArray((body as { conversations?: unknown }).conversations)
        ) {
          json(res, 400, { error: "expected { connector: string, conversations: [] }" });
          return;
        }
        const envelope = body as { connector: string; conversations: unknown[] };
        const connector = ctx.byId.get(envelope.connector);
        if (!connector || !connector.push) {
          json(res, 400, { error: `unknown or non-push connector: ${envelope.connector}` });
          return;
        }
        // Reuse the connector's EXISTING parse seam: re-stringify just the conversations
        // array (the exact shape the pure parser expects). Tolerant parser → a wrong-shape
        // conversation is skipped, not a 500; the receiver still returns 200 with counts.
        const result = connector.parse(JSON.stringify(envelope.conversations));
        for (const r of result.rawRecords) {
          ctx.queue.enqueue("raw", `${r.sourceConnector}:${r.id}`, toRawRecordPayload(r));
        }
        for (const e of result.events) {
          ctx.queue.enqueue("event", e.fingerprint, toEventPayload(e));
        }
        if (result.rawRecords.length > 0 || result.events.length > 0) {
          ctx.log(
            `${connector.id}: ${result.rawRecords.length} record(s), ${result.events.length} event(s) pushed`,
          );
        }
        json(res, 200, { rawRecords: result.rawRecords.length, events: result.events.length });
      } catch {
        // Malformed envelope JSON (not the conversation content) → bad request.
        json(res, 400, { error: "invalid JSON body" });
      }
    });
  } catch {
    // Truly unexpected — degrade to 500 without crashing the server.
    json(res, 500, { error: "internal error" });
  }
}

/** The actually-bound port (ephemeral resolution for `port: 0`). */
function addressPort(server: Server): number {
  const addr = server.address() as AddressInfo | null;
  return addr ? addr.port : 0;
}

/**
 * Run the push receiver until `signal` aborts (then the server CLOSES and the promise
 * resolves) — so it slots into the engine's `Promise.allSettled` unwind exactly like
 * `pollLoop`. NEVER throws (best-effort): a port-in-use (`EADDRINUSE`) or any listen/
 * request error is logged and degrades to a resolved promise — it never stops capture.
 *
 * Leak-window discipline (CLAUDE.md): the abort listener is armed SYNCHRONOUSLY, before
 * `listen` resolves, so an abort during startup still tears the server down cleanly.
 */
export function runPushServer(opts: PushServerOptions, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const host = opts.host ?? "127.0.0.1";
    const byId = new Map(opts.connectors.map((c) => [c.id, c]));
    const ctx: HandlerContext = { ...opts, byId };
    const server = createServer((req, res) => handleRequest(req, res, ctx));

    const onAbort = (): void => {
      // Drop keep-alive connections so `close` fires promptly (frees the port at once).
      server.closeAllConnections?.();
      server.close();
    };
    signal.addEventListener("abort", onAbort, { once: true }); // armed BEFORE listen resolves

    server.on("close", () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    server.on("error", (err) => {
      // e.g. EADDRINUSE — a second collector or a stale port. Degrade, never stop capture.
      opts.log(`push server error: ${(err as Error).message}`);
      signal.removeEventListener("abort", onAbort);
      resolve();
    });

    server.listen(opts.port ?? DEFAULT_PUSH_PORT, host, () => opts.onListen?.(addressPort(server)));
  });
}
