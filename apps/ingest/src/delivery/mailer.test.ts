import { describe, it, expect, vi } from "vitest";
import type { MailTransport } from "./smtp-deliverer.js";
import { createMailer } from "./mailer.js";

/**
 * M15 15.5 — unit tests for the transactional mailer, with an INJECTED fake transport so no test
 * ever opens SMTP (CLAUDE.md: inject dependencies for determinism). Mirrors
 * `smtp-deliverer.test.ts`, which is the point of reusing `MailTransport` rather than declaring a
 * second structural interface: one fake shape serves both files.
 */

const CFG = {
  url: "smtps://u:p@mail.local:465",
  from: "no-reply@420.ai",
  appBaseUrl: "https://app.420.ai",
};

describe("createMailer", () => {
  it("returns null when cfg is null (no mail transport configured)", () => {
    // The null case is load-bearing, not a nicety: it is what the two callers BRANCH on, and they
    // branch differently — the admin-gated invite route hands the token back, the unauthenticated
    // reset route 503s (D-15.5-10).
    expect(createMailer(null)).toBeNull();
  });

  it("forwards from/to/subject/text to the transport unchanged", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const transport: MailTransport = { sendMail };
    const mailer = createMailer(CFG, () => transport)!;

    await mailer.send({ to: "invitee@example.com", subject: "hello", text: "body line" });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: "no-reply@420.ai",
      to: "invitee@example.com",
      subject: "hello",
      text: "body line",
    });
  });

  it("exposes appBaseUrl so routes build links without re-reading env", () => {
    const mailer = createMailer(CFG, () => ({ sendMail: vi.fn() }))!;
    expect(mailer.appBaseUrl).toBe("https://app.420.ai");
  });

  it("builds the transport ONCE, not per send", async () => {
    // A per-send `createTransport` would open a fresh connection pool for every invite.
    const factory = vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) }) as MailTransport);
    const mailer = createMailer(CFG, factory)!;
    await mailer.send({ to: "a@b.c", subject: "s", text: "t" });
    await mailer.send({ to: "d@e.f", subject: "s", text: "t" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("propagates a transport failure rather than swallowing it", async () => {
    // The mailer THROWS; the ROUTE decides what that means. The reset route logs and still answers
    // 202 (a 500 there would re-open the user-enumeration oracle the always-202 rule closes), while
    // the invite route lets it surface. Deciding that here would take the choice away from both.
    const transport: MailTransport = {
      sendMail: vi.fn().mockRejectedValue(new Error("smtp down")),
    };
    const mailer = createMailer(CFG, () => transport)!;
    await expect(mailer.send({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(
      "smtp down",
    );
  });
});
