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
 * The webhook envelope `kind` is derived from the firing's own status so the SAME deliverer
 * serves both open-firing delivery (deliverPendingFirings) and resolve-notice delivery
 * (deliverResolvedFirings, M13 13.5): a resolved firing carries `status:"resolved"` → the
 * consumer sees `alert.resolved` and can clear its notification. An open firing is unchanged
 * (`alert.firing`) — the existing webhook contract holds byte-for-byte.
 */
function firingKind(firing: AlertFiring): "alert.firing" | "alert.resolved" {
  return firing.status === "resolved" ? "alert.resolved" : "alert.firing";
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
        body: JSON.stringify({ kind: firingKind(firing), firing }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
    },
  };
}
