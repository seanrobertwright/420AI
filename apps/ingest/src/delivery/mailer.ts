import nodemailer from "nodemailer";
import type { MailTransport } from "./smtp-deliverer.js";

/**
 * M15 15.5 — transactional mail (invites, password resets). Reuses M13 13.5's nodemailer
 * transport at the TRANSPORT level, not the deliverer level: `AlertDeliverer.deliver(firing)`
 * takes an `AlertFiring` and cannot express an invite. `MailTransport` (smtp-deliverer.ts:26-28)
 * is already the right structural subset, so it is imported rather than redeclared — one fake
 * transport shape serves both files' unit tests.
 *
 * Returns `null` when unconfigured, mirroring `createSmtpDeliverer` (smtp-deliverer.ts:60).
 * Callers branch on null: the admin-gated invite route hands the token back in its response
 * (D-15.5-10, same precedent as `POST /v1/pairing-codes`), while the UNAUTHENTICATED
 * password-reset route 503s — returning a reset token to an anonymous caller would be a
 * complete account-takeover primitive.
 *
 * Never logs (CLAUDE.md: libraries throw, entrypoints log). `send` THROWS on failure.
 */
export interface MailerConfig {
  url: string;
  from: string;
  /** Base URL of the DASHBOARD, used to build invite/reset links. Defaults to
   *  http://localhost:3000 (`next dev`'s port) when APP_BASE_URL is unset. */
  appBaseUrl: string;
}

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
  /** Exposed so routes build links without re-reading env. */
  readonly appBaseUrl: string;
}

export function createMailer(
  cfg: MailerConfig | null,
  transportFactory: (url: string) => MailTransport = (url) =>
    nodemailer.createTransport(url) as unknown as MailTransport,
): Mailer | null {
  if (!cfg) return null;
  const transport = transportFactory(cfg.url);
  return {
    appBaseUrl: cfg.appBaseUrl,
    async send({ to, subject, text }) {
      await transport.sendMail({ from: cfg.from, to, subject, text });
    },
  };
}
