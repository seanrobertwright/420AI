import { describe, it, expect, vi } from "vitest";
import type { AlertFiring } from "@420ai/shared";
import type { AlertDeliverer } from "./alert-deliverer.js";
import {
  createSmtpDeliverer,
  createFanoutDeliverer,
  type MailTransport,
} from "./smtp-deliverer.js";

/** A minimal firing fixture; `over` tweaks status/severity/fields per test. */
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

describe("createSmtpDeliverer", () => {
  it("returns null when cfg is null (delivery disabled)", () => {
    expect(createSmtpDeliverer(null)).toBeNull();
  });

  it("sends a plain-text email with from/to and an OPEN-firing subject", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const transport: MailTransport = { sendMail };
    const deliverer = createSmtpDeliverer(
      { url: "smtps://u:p@mail.local:465", from: "alerts@420.ai", to: "me@420.ai" },
      () => transport,
    )!;

    await deliverer.deliver(firing());

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0];
    expect(mail.from).toBe("alerts@420.ai");
    expect(mail.to).toBe("me@420.ai");
    expect(mail.subject).toBe("[420AI] critical collector.offline:m1");
    expect(mail.subject).not.toContain("RESOLVED");
    expect(mail.text).toContain(`Collector "laptop" is offline`);
    expect(mail.text).toContain("Status:   open");
  });

  it("labels a RESOLVED firing's subject + body", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const deliverer = createSmtpDeliverer(
      { url: "smtps://u:p@mail.local:465", from: "a@x", to: "b@x" },
      () => ({ sendMail }),
    )!;

    await deliverer.deliver(firing({ status: "resolved", resolvedAt: "2026-06-15T13:00:00.000Z" }));

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.subject).toBe("[420AI] RESOLVED critical collector.offline:m1");
    expect(mail.text).toContain("Resolved: 2026-06-15T13:00:00.000Z");
  });

  it("propagates a transport failure (so the caller logs it)", async () => {
    const deliverer = createSmtpDeliverer(
      { url: "smtps://u:p@mail.local:465", from: "a@x", to: "b@x" },
      () => ({ sendMail: vi.fn().mockRejectedValue(new Error("smtp down")) }),
    )!;
    await expect(deliverer.deliver(firing())).rejects.toThrow(/smtp down/);
  });
});

describe("createFanoutDeliverer", () => {
  /** A deliverer that records calls and optionally throws. */
  function stub(over: { fail?: boolean } = {}): { d: AlertDeliverer; calls: AlertFiring[] } {
    const calls: AlertFiring[] = [];
    const d: AlertDeliverer = {
      async deliver(f) {
        calls.push(f);
        if (over.fail) throw new Error("child failed");
      },
    };
    return { d, calls };
  }

  it("returns null when no child is configured (all null)", () => {
    expect(createFanoutDeliverer([null, null])).toBeNull();
  });

  it("delivers to every non-null child exactly once", async () => {
    const a = stub();
    const b = stub();
    const fan = createFanoutDeliverer([a.d, null, b.d])!;
    const f = firing();
    await fan.deliver(f);
    expect(a.calls).toEqual([f]);
    expect(b.calls).toEqual([f]);
  });

  it("isolation: a failing child does NOT skip the others; errors aggregate into one throw", async () => {
    const bad = stub({ fail: true });
    const good = stub();
    const fan = createFanoutDeliverer([bad.d, good.d])!;

    await expect(fan.deliver(firing())).rejects.toThrow(AggregateError);
    // The healthy child still received the firing despite the sibling throwing.
    expect(good.calls).toHaveLength(1);
    expect(bad.calls).toHaveLength(1);
  });

  it("does not throw when all children succeed", async () => {
    const a = stub();
    const b = stub();
    const fan = createFanoutDeliverer([a.d, b.d])!;
    await expect(fan.deliver(firing())).resolves.toBeUndefined();
  });
});
