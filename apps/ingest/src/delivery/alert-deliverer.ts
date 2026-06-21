import type { AlertFiring } from "@420ai/shared";

/**
 * M12 12.6 alert delivery (PRD §20). An INJECTED sink that pushes a newly-opened firing
 * to an external target — a webhook today (Slack/Discord/n8n/email-bridge), email later
 * behind the SAME interface. Cloned from `analysis/provider.ts`'s injected-interface
 * shape, but the not-configured stand-in is `null` (delivery is opt-in like rateLimit),
 * NOT a throwing stub.
 *
 * Silent library (CLAUDE.md): `deliver` THROWS on failure; the caller
 * (`deliverPendingFirings`) swallows + logs it. Never log here.
 */
export interface AlertDeliverer {
  deliver(firing: AlertFiring): Promise<void>;
}

export interface WebhookDelivererConfig {
  url: string;
  timeoutMs: number; // AbortSignal.timeout — a Node-24 built-in (no dependency)
}

/**
 * POST the firing JSON to a generic webhook. Throws on non-2xx / network / timeout so the
 * caller can log it; exactly one attempt per firing (the caller stamps delivery_attempted_at).
 * Returns `null` when `cfg` is null (no ALERT_WEBHOOK_URL) — delivery disabled, mirroring
 * the rateLimit opt-in: every existing buildApp caller passes nothing → null → no-op.
 */
export function createWebhookDeliverer(cfg: WebhookDelivererConfig | null): AlertDeliverer | null {
  if (!cfg) return null;
  return {
    async deliver(firing: AlertFiring): Promise<void> {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "alert.firing", firing }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
    },
  };
}
