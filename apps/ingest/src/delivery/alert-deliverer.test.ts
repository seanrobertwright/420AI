import { describe, it, expect, vi, afterEach } from "vitest";
import type { AlertFiring } from "@420ai/shared";
import { createWebhookDeliverer } from "./alert-deliverer.js";

/** A minimal open firing fixture (only the fields the webhook body carries verbatim). */
function firing(over: Partial<AlertFiring> = {}): AlertFiring {
  return {
    id: "f1",
    alertKey: "collector.offline:m1",
    code: "collector.offline",
    severity: "critical",
    message: `Collector "laptop" is offline`,
    machineId: "m1",
    machineName: "laptop",
    connector: null,
    since: "2026-06-15T11:50:00.000Z",
    status: "open",
    firstFiredAt: "2026-06-15T12:00:00.000Z",
    lastSeenAt: "2026-06-15T12:00:00.000Z",
    resolvedAt: null,
    ackedAt: null,
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("createWebhookDeliverer", () => {
  it("returns null when cfg is null (delivery disabled)", () => {
    expect(createWebhookDeliverer(null)).toBeNull();
  });

  it("POSTs the firing JSON to the configured url with content-type + timeout signal", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const deliverer = createWebhookDeliverer({ url: "http://hook.local/x", timeoutMs: 5000 })!;
    const f = firing();
    await deliverer.deliver(f);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://hook.local/x");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ kind: "alert.firing", firing: f });
  });

  it("emits kind 'alert.resolved' for a resolved firing (deliver-on-resolve, M13 13.5)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const deliverer = createWebhookDeliverer({ url: "http://hook.local/x", timeoutMs: 5000 })!;
    const f = firing({ status: "resolved", resolvedAt: "2026-06-15T13:00:00.000Z" });
    await deliverer.deliver(f);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ kind: "alert.resolved", firing: f });
  });

  it("throws on a non-2xx response (so the caller logs it)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response) as unknown as typeof fetch;
    const deliverer = createWebhookDeliverer({ url: "http://hook.local/x", timeoutMs: 5000 })!;
    await expect(deliverer.deliver(firing())).rejects.toThrow(/500/);
  });
});
