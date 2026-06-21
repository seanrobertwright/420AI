# Signing & applying a pricing-catalog update (M10 3d — PRD §10.4/§18/§20)

The pricing catalog (`model → ModelPricing`) can be updated **without an app release**, but only via a
**cryptographically signed** update that you then **approve**. This is _not_ an AI/LLM feature — it is an
operator workflow secured with an **ed25519** keypair:

- **Private key** (`.secrets/catalog-private-key.pem`) — _creates_ signatures. **Secret. Offline only.**
  It never enters the repo, the server, or any running process. Used solely by `scripts/sign-catalog.ts`.
- **Public key** (`CATALOG_PUBLIC_KEY` in `packages/shared/src/catalog-signing.ts`) — _verifies_
  signatures. Bundled in source, safe to ship. The server uses it to confirm an upload is genuine.

A catalog only ever changes a computed cost after **both** gates pass: a valid signature **and** explicit
admin approval. With no active catalog, ingest is byte-identical to the bundled `PRICING_CATALOG` baseline.

---

## One-time setup (already done; here for disaster recovery)

The keypair was generated once into the gitignored `.secrets/` directory:

```bash
mkdir -p .secrets
node -e "const c=require('node:crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');require('node:fs').writeFileSync('.secrets/catalog-public-key.pem',publicKey.export({type:'spki',format:'pem'}));require('node:fs').writeFileSync('.secrets/catalog-private-key.pem',privateKey.export({type:'pkcs8',format:'pem'}));console.log('wrote .secrets/catalog-{public,private}-key.pem')"
```

> ⚠️ **If you lose `catalog-private-key.pem`, you can no longer sign catalogs** — there is no key
> rotation in V1. Recovery = regenerate the pair (command above) **and** paste the new
> `.secrets/catalog-public-key.pem` verbatim into `CATALOG_PUBLIC_KEY` in
> `packages/shared/src/catalog-signing.ts`, then ship that code change. Back the private key up somewhere
> safe and **never commit it** (`.secrets/`, `*.pem`, `*.key` are all gitignored).

---

## Updating prices

### 1. Write the catalog JSON

Shape: `{ "version": string, "payload": { "<model-id>": ModelPricing } }`. Bump `version` for every
change (it is the idempotency key — re-uploading an existing version is a no-op). Rates are USD **per
single token** (per-MTok ÷ 1e6). Start from the current `PRICING_CATALOG` in
`packages/shared/src/pricing.ts` and change what you need.

```json
{
  "version": "m10-catalog-v2",
  "payload": {
    "claude-opus-4-8": {
      "input": 6e-6,
      "output": 30e-6,
      "cache_read": 0.6e-6,
      "cache_write": 7.5e-6,
      "sourceUrl": "https://www.anthropic.com/pricing",
      "asOf": "2026-06-20"
    }
  }
}
```

### 2. Sign it (offline)

```bash
npx tsx scripts/sign-catalog.ts catalog.json --key .secrets/catalog-private-key.pem > signed.json
# or: CATALOG_SIGNING_KEY=.secrets/catalog-private-key.pem npx tsx scripts/sign-catalog.ts catalog.json > signed.json
```

`signed.json` is `{ version, payload, signature }` — the exact body to POST. The signer shares the **same**
`canonicalizeCatalog` the server verifies with, so a signature made here always verifies there.

### 3. Upload → it lands `pending`

```bash
curl -X POST "$INGEST_URL/v1/catalog" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d @signed.json
# → 200 { "id": "...", "status": "pending", ... }   (a bad/tampered signature → 400)
```

(`$INGEST_URL` defaults to `http://localhost:8420`; `$ADMIN_TOKEN` is the server's admin token.)

While anything is pending, `GET /v1/catalog` lists it and `GET /v1/monitor` shows a
`catalog.update_requires_approval` operational alert.

### 4. Approve (or reject) → it goes `active`

```bash
curl -X POST "$INGEST_URL/v1/catalog/<id>/approve" -H "authorization: Bearer $ADMIN_TOKEN"
# → 200 { "status": "active" }   (the prior active catalog is atomically superseded; the §20 alert clears)

# or, to discard it:
curl -X POST "$INGEST_URL/v1/catalog/<id>/reject"  -H "authorization: Bearer $ADMIN_TOKEN"
```

From approval onward, the server **re-prices new ingests** under the active catalog and stamps their
`catalog_version`. **Going forward only** — historical rows keep their original prices until the (deferred)
archive-replay engine ships.

---

## Endpoints (all admin-gated)

| Method & path                  | Effect                                             |
| ------------------------------ | -------------------------------------------------- |
| `POST /v1/catalog`             | verify signature → store `pending` (bad sig → 400) |
| `GET /v1/catalog`              | list all catalogs (newest first)                   |
| `POST /v1/catalog/:id/approve` | `pending → active`, supersede prior active         |
| `POST /v1/catalog/:id/reject`  | `pending → rejected`                               |

Lifecycle: `pending → active → superseded` (or `pending → rejected`). At most one `active` at a time
(enforced by a partial-unique DB index).
