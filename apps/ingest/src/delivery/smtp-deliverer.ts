import nodemailer from "nodemailer";
import type { AlertFiring } from "@420ai/shared";
import type { AlertDeliverer } from "./alert-deliverer.js";

/**
 * M13 13.5 SMTP alert delivery (PRD §20). A second `AlertDeliverer` beside the webhook one,
 * behind the SAME injected-interface contract: `deliver` THROWS on failure; the caller
 * (`deliverPendingFirings`/`deliverResolvedFirings`) swallows + logs it. The not-configured
 * stand-in is `null` (delivery is opt-in like the webhook), NOT a throwing stub. Never log here.
 *
 * Config is a single `smtps://user:pass@host:port` URL (mirrors ALERT_WEBHOOK_URL's one-var
 * shape) plus explicit from/to addresses. Both open firings and resolve notices flow through
 * `deliver`; the subject/body reflect `firing.status` so a resolved firing reads as RESOLVED.
 */
export interface SmtpDelivererConfig {
  url: string; // smtps://user:pass@host:port (nodemailer transport URL)
  from: string;
  to: string;
}

/**
 * The minimal transport surface `createSmtpDeliverer` needs — a structural subset of
 * nodemailer's Transporter. Injected in tests as `{ sendMail: vi.fn() }` so no unit test
 * ever opens a live SMTP connection (CLAUDE.md: inject dependencies for determinism).
 */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Human-readable subject/body lines for a firing (resolve notices are labelled RESOLVED). */
function renderMail(firing: AlertFiring): { subject: string; text: string } {
  const resolved = firing.status === "resolved";
  const subject = `[420AI] ${resolved ? "RESOLVED " : ""}${firing.severity} ${firing.alertKey}`;
  const text = [
    firing.message,
    "",
    `Severity: ${firing.severity}`,
    `Status:   ${firing.status}`,
    firing.machineName ? `Machine:  ${firing.machineName}` : null,
    firing.connector ? `Connector: ${firing.connector}` : null,
    firing.since ? `Since:    ${firing.since}` : null,
    `Opened:   ${firing.firstFiredAt}`,
    resolved && firing.resolvedAt ? `Resolved: ${firing.resolvedAt}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  return { subject, text };
}

/**
 * Deliver a firing as a plain-text email via nodemailer. Returns `null` when `cfg` is null
 * (SMTP not configured) — mirroring the webhook opt-in. `transportFactory` is injectable so
 * unit tests pass a fake transport; production uses `nodemailer.createTransport(url)`.
 */
export function createSmtpDeliverer(
  cfg: SmtpDelivererConfig | null,
  transportFactory: (url: string) => MailTransport = (url) =>
    nodemailer.createTransport(url) as unknown as MailTransport,
): AlertDeliverer | null {
  if (!cfg) return null;
  const transport = transportFactory(cfg.url);
  return {
    async deliver(firing: AlertFiring): Promise<void> {
      const { subject, text } = renderMail(firing);
      await transport.sendMail({ from: cfg.from, to: cfg.to, subject, text });
    },
  };
}

/**
 * Compose several deliverers into ONE (the app has a single `alertDeliverer` slot). Delivers to
 * every non-null child concurrently; a child that throws does NOT skip the others (Promise.allSettled),
 * and the per-child failures are aggregated into a single throw so the caller's log/stamp path is
 * unchanged (still at-most-once). Returns `null` when NO child is configured — so the default
 * no-webhook/no-SMTP case stays a cheap early-return in deliverPendingFirings.
 */
export function createFanoutDeliverer(
  deliverers: (AlertDeliverer | null)[],
): AlertDeliverer | null {
  const active = deliverers.filter((d): d is AlertDeliverer => d !== null);
  if (active.length === 0) return null;
  return {
    async deliver(firing: AlertFiring): Promise<void> {
      const results = await Promise.allSettled(active.map((d) => d.deliver(firing)));
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `${errors.length}/${active.length} alert deliverers failed`,
        );
      }
    },
  };
}
