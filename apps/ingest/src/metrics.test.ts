import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createMetrics, registerMetricsHook } from "./metrics.js";

describe("metrics store (M12 12.4b)", () => {
  it("starts zeroed with the injected startedAt", () => {
    const m = createMetrics(1000);
    expect(m.startedAt).toBe(1000);
    expect(m.requests).toBe(0);
    expect(m.byStatusClass).toEqual({});
    expect(m.ingestRecordsInserted).toBe(0);
    expect(m.ingestEventsUpserted).toBe(0);
  });

  it("counts responses by status class via the onResponse hook", async () => {
    const app = Fastify({ logger: false });
    app.decorate("metrics", createMetrics(1000));
    registerMetricsHook(app);
    app.get("/ok", async () => ({ ok: true }));
    app.get("/boom", async (_req, reply) => reply.code(500).send({ error: "x" }));
    app.get("/missing-ish", async (_req, reply) => reply.code(404).send({ error: "x" }));

    await app.inject({ method: "GET", url: "/ok" });
    await app.inject({ method: "GET", url: "/ok" });
    await app.inject({ method: "GET", url: "/boom" });
    await app.inject({ method: "GET", url: "/missing-ish" });

    const m = app.metrics;
    expect(m.requests).toBe(4);
    expect(m.byStatusClass["2xx"]).toBe(2);
    expect(m.byStatusClass["5xx"]).toBe(1);
    expect(m.byStatusClass["4xx"]).toBe(1);
    await app.close();
  });
});
