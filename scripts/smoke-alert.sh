#!/bin/sh
# M14 pre-sign-off (checklist item 5) — force ONE real alert firing to test SMTP/webhook delivery.
# Usage:  INGEST_URL=http://localhost:8420 API_KEY=<k420_...> sh scripts/smoke-alert.sh
#
# HOW IT WORKS: lands >=3 invalid-bearer requests against a bodyless machine-authed route
# (GET /v1/connector-catalog/active) within the 15-min window, each recording an
# `ingest_auth_failures` row. Then it polls GET /v1/monitor (admin) so the evaluate-on-read
# reconcile opens the `ingest.auth_failure` firing and the alertDeliverer sends it. The firing
# auto-resolves as the failures age out — no cleanup needed.
#
# WHY a bodyless GET (not POST /v1/ingest): the auth check is a Fastify preHandler, which runs
# AFTER schema validation — a POST with a malformed body would 400 before the auth hook ever runs,
# so no failure is recorded. A bodyless GET has no schema gate, so the bad bearer reaches the auth
# hook (and records a failure) every time.
set -eu

INGEST_URL="${INGEST_URL:-http://localhost:8420}"
: "${API_KEY:?set API_KEY (needed for the GET /v1/monitor reconcile poll; ADMIN_TOKEN was retired in M15 15.9 — mint a key under Settings → API keys)}"
ATTEMPTS="${ATTEMPTS:-4}"   # >=3 to cross the threshold; one extra for margin

echo "== forcing ingest.auth_failure firing =="
echo "target: $INGEST_URL"

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -H 'authorization: Bearer smoke-invalid-token' \
    "$INGEST_URL/v1/connector-catalog/active" || echo 000)"
  echo "  bad-bearer attempt $i → HTTP $code (expect 401)"
  i=$((i + 1))
done

# small settle so the best-effort failure records commit before the reconcile reads them
sleep 2

echo "== triggering evaluate-on-read reconcile (GET /v1/monitor) =="
mcode="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $API_KEY" "$INGEST_URL/v1/monitor" || echo 000)"
echo "  GET /v1/monitor → HTTP $mcode (expect 200)"

cat <<'EOF'

== next ===
- If ALERT_SMTP_URL / ALERT_EMAIL_FROM / ALERT_EMAIL_TO are set, a delivery attempt fired now.
  Check the ALERT_EMAIL_TO inbox for the ingest.auth_failure alert email.
- If ALERT_WEBHOOK_URL is set, the firing JSON was POSTed there instead/as well.
- Either way, the firing should now be visible in the dashboard Monitor AlertsPanel.
- Delivery is at-most-ONE attempt per firing (delivery_attempted_at), so re-run only after the
  current firing has resolved (failures age out of the 15-min window).
EOF
