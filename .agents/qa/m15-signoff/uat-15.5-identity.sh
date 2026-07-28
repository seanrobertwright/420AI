#!/usr/bin/env bash
# M15 15.5 identity core — Level 5 manual validation (D-M15-13 evidence).
#
# Boots against a REAL ingest server with SELF_SIGNUP_ENABLED unset and NO SMTP configured, i.e.
# the default posture of a fresh self-hosted box. Run from the repo root with the server already
# listening on $PORT, against a FRESH database (the invite/dedup steps assume no prior run).
#
# Uses curl.exe with FILE-BASED JSON bodies: in PowerShell bare `curl` is an alias for
# Invoke-WebRequest and `\"` escaping does not survive (project gotcha).
#
# EVERY endpoint is called EXACTLY ONCE and the single response is both printed and parsed. An
# earlier draft used one call to print and a second to capture, which silently made step 2's
# capture hit the invite-dedup 409 and cascaded an empty token through every later step — a good
# reminder that a UAT script's own bugs read exactly like product failures.
set -uo pipefail
PORT=${PORT:-8425}
BASE="http://localhost:$PORT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BODY=""
say() { printf '\n=== %s ===\n' "$1"; }

# call METHOD PATH [BEARER] [BODY_FILE] → prints "<body>\n[<status>]" and sets $BODY.
call() {
  local method=$1 path=$2 bearer=${3:-} file=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" "$BASE$path")
  [ -n "$bearer" ] && args+=(-H "authorization: Bearer $bearer")
  [ -n "$file" ] && args+=(-H "content-type: application/json" -d "@$file")
  local code
  code=$(curl.exe "${args[@]}")
  BODY=$(cat "$TMP/body")
  printf '%s\n[%s]\n' "$BODY" "$code"
}

# Extract one field from $BODY with node (jq is not guaranteed on this box).
field() { printf '%s' "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;console.log(v??'')}catch{console.log('')}})"; }

say "0. health"
call GET /v1/health

say "1. log in as the bootstrap admin"
printf '{"email":"uat-admin@test.local","password":"uat-password-1234"}' > "$TMP/login.json"
call POST /v1/auth/login "" "$TMP/login.json"
SESSION=$(field 'j.token')

say "2. invite a colleague — NO SMTP configured, so the token comes back in the body (D-15.5-10)"
printf '{"email":"UAT-Colleague@Example.COM","role":"member"}' > "$TMP/invite.json"
call POST /v1/members/invite "$SESSION" "$TMP/invite.json"
TOKEN=$(field 'j.token')

say "2b. a second invite for the same PENDING address is 409, not a duplicate token"
call POST /v1/members/invite "$SESSION" "$TMP/invite.json"

say "3. preview the invite (unauthenticated) — note the LOWERCASED email (D-15.5-3)"
call GET "/v1/auth/invites/$TOKEN"

say "4. accept it — returns a session, so the invitee is already logged in"
printf '{"token":"%s","password":"colleague-passphrase"}' "$TOKEN" > "$TMP/accept.json"
call POST /v1/auth/invites/accept "" "$TMP/accept.json"
NEW=$(field 'j.token')

say "4b. …and that session identifies the INVITEE (the GOTCHA-1 check: the inviting org, not a new one)"
call GET /v1/auth/me "$NEW"

say "4c. the MIXED-CASE spelling logs in to the SAME account (D-15.5-3)"
printf '{"email":"UAT-COLLEAGUE@EXAMPLE.COM","password":"colleague-passphrase"}' > "$TMP/mixed.json"
call POST /v1/auth/login "" "$TMP/mixed.json"

say "5. the org now holds TWO people"
call GET /v1/members "$SESSION"

say "6. escalation guard: the OWNER may invite an owner…"
printf '{"email":"uat-owner2@example.com","role":"owner"}' > "$TMP/owner.json"
call POST /v1/members/invite "$SESSION" "$TMP/owner.json"

say "6b. …but the new MEMBER cannot invite at all (403 — needs admin)"
call POST /v1/members/invite "$NEW" "$TMP/invite.json"

say "7. last-owner guard: removing the sole owner is 409 (D-15.5-12)"
call GET /v1/members "$SESSION"
OWNER_ID=$(field 'j.members.find(m=>m.role==="owner").userId')
call DELETE "/v1/members/$OWNER_ID" "$SESSION"

say "8. signup is refused by default (D-M15-6 / D-15.5-5) — 403, not 404"
printf '{"email":"walkin@example.com","password":"walkin-passphrase"}' > "$TMP/signup.json"
call POST /v1/auth/signup "" "$TMP/signup.json"

say "9. password reset with NO mailer is 503, and returns no token (D-15.5-10)"
printf '{"email":"uat-admin@test.local"}' > "$TMP/reset.json"
call POST /v1/auth/password-reset "" "$TMP/reset.json"

say "10. THE CLOSED PRIMITIVE (D-M15-8) — pairing code for a non-member email is 404"
printf '{"email":"stranger@nowhere.test"}' > "$TMP/stranger.json"
call POST /v1/pairing-codes "$SESSION" "$TMP/stranger.json"

say "10b. …and for a genuine colleague it still issues a code"
printf '{"email":"uat-colleague@example.com"}' > "$TMP/colleague.json"
call POST /v1/pairing-codes "$SESSION" "$TMP/colleague.json"

say "11. change own password: a wrong current password is 401…"
printf '{"currentPassword":"wrong","newPassword":"another-passphrase"}' > "$TMP/badpw.json"
call POST /v1/auth/password "$NEW" "$TMP/badpw.json"

say "11b. …the right one is 204, and the new password then logs in"
printf '{"currentPassword":"colleague-passphrase","newPassword":"another-passphrase"}' > "$TMP/goodpw.json"
call POST /v1/auth/password "$NEW" "$TMP/goodpw.json"
printf '{"email":"uat-colleague@example.com","password":"another-passphrase"}' > "$TMP/relogin.json"
call POST /v1/auth/login "" "$TMP/relogin.json"

say "12. and the OLD password no longer works"
call POST /v1/auth/login "" "$TMP/mixed.json"

say "DONE"
