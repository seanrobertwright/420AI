# M12 12.3 — Auth hardening live QA

Evidence folder for the **12.3 auth live QA** pre-sign-off item (M14 D-M14-4 checklist, item 4).
Its absence was one of the two "hard not-done" warnings in `SUMMARY.md` §0. Drop the screenshots
listed below here to clear it.

**What 12.3 shipped:** a real single-user admin login (retiring the static `ADMIN_TOKEN` /
hardcoded `DEFAULT_EMAIL` for the human path); a session cookie resolved server-side; the
browser never holds `ADMIN_TOKEN` (same-origin proxy discipline).

## Shot list (capture against a running dashboard + ingest)

| File | What it must show |
|------|-------------------|
| `01-login-page.png` | The `/login` page rendered. |
| `02-wrong-password.png` | Submitting a wrong password → 401 / error message, no session set. |
| `03-login-success.png` | Correct password → redirect to an authenticated page. |
| `04-auth-me.png` | `GET /api/auth/me` response (or the nav element) showing the **admin email** — proves the session cookie resolves server-side. |
| `05-logout.png` | After logout, a protected route redirects back to `/login`. |
| `06-no-token-in-html.txt` | Output of `curl -s <dashboard-url>/<authed-page> \| grep -c "$ADMIN_TOKEN"` → **must be `0`** (token never in served HTML). |

## Notes

- Redact nothing that isn't a secret, but **do not** paste a real admin password or token into any
  saved artifact.
- The `grep -c` proof is the load-bearing security assertion for this slice — capture it verbatim.
- Once all shots are here, check item 4 in
  [`../m14-signoff/CHECKLIST.md`](../m14-signoff/CHECKLIST.md) and in the milestone plan.
