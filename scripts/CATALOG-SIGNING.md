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
`catalog_version`. Historical rows keep their original prices until you run the archive-replay engine
(`npm run db:reprice` or `POST /v1/replay/reprice`, shipped M12 12.5a) to re-price them retroactively.

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

---

## Signing & applying a CONNECTOR-catalog update (M12 12.7c — PRD §10.4)

The **connector catalog** (`ConnectorCatalogPayload`) lets you update connector **metadata + watch
locations** — a corrected glob, a new fidelity label, a tightened/loosened permission scope, an
enable/disable, or a whole new **data-only** custom connector — **without an app release**, secured by the
**same** ed25519 machinery as pricing but a **separate keypair**:

- **Private key** `.secrets/connector-catalog-private-key.pem` — _creates_ signatures. **Secret, offline.**
- **Public key** `CONNECTOR_CATALOG_PUBLIC_KEY` in `packages/shared/src/connector-catalog.ts` — _verifies_
  them. Bundled in source. The server verifies uploads; the **collector re-verifies** the pulled catalog
  against this key before applying it (defense-in-depth — a tampered local cache is ignored).

> **Decision A (PRD §39): parsers stay code.** The catalog overlays locations/fidelity/permissions/active
> onto code-keyed connectors **by id**; an entry with no built-in id and a `def` is compiled by the
> existing custom-connector factory. No plugin/script runtime is introduced.

With **no active catalog** the collector registry is **byte-identical to today** (the bundled
`CONNECTOR_CATALOG_BASELINE` is the floor). A catalog update that **widens** a connector's
`watchGlobs`/`requiredPermissions` flips it to **`needs-approval`** (the §10.4 capture-surface-change gate,
12.7b) until the user approves it in the desktop app.

### 1. Write the connector-catalog JSON

Shape: `{ "version": string, "payload": { "connectors": ConnectorCatalogEntry[] } }`. Each entry overlays
by `id`; omitted fields are left untouched. Start from `CONNECTOR_CATALOG_BASELINE` in
`packages/shared/src/connector-catalog.ts`.

> **`watchGlobs` are ABSOLUTE and are NOT `~`-expanded** (same convention as a local custom connector) —
> a `watchGlobs` override resolves verbatim, so it is **machine-specific**. Prefer overriding fidelity /
> `requiredPermissions` (portable across machines) in a global catalog; only override `watchGlobs` when
> every target machine shares the path layout.

```json
{
  "version": "m12-connector-catalog-v2",
  "payload": {
    "connectors": [
      {
        "id": "claude-code",
        "fidelity": { "requiredPermissions": ["Read Claude Code transcripts (reviewed 2026-06)"] }
      },
      {
        "id": "custom-syslog",
        "def": {
          "id": "custom-syslog",
          "watchGlobs": ["/var/log/app.jsonl"],
          "format": "jsonl",
          "eventType": "message.user"
        }
      }
    ]
  }
}
```

### 2. Sign it (offline — note the `--connector` flag + the connector key)

```bash
npx tsx scripts/sign-catalog.ts --connector connector-catalog.json --key .secrets/connector-catalog-private-key.pem > signed.json
# or: CONNECTOR_CATALOG_SIGNING_KEY=.secrets/connector-catalog-private-key.pem npx tsx scripts/sign-catalog.ts --connector connector-catalog.json > signed.json
```

### 3. Upload → approve (admin), then the collector pulls it

```bash
curl -X POST "$INGEST_URL/v1/connector-catalog" -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d @signed.json
# → 200 pending   (bad/tampered signature → 400)
curl -X POST "$INGEST_URL/v1/connector-catalog/<id>/approve" -H "authorization: Bearer $ADMIN_TOKEN"
# → 200 active   (prior active atomically superseded)
```

The collector pulls the **active** catalog at startup via the **machine-authed** `GET
/v1/connector-catalog/active` (its ingest token, not the admin token), caches it at
`~/.420ai/connector-catalog.json`, and overlays it onto the registry. **Offline-first:** a failed pull
falls back to the cache, then the bundled baseline — capture never blocks.

### Connector-catalog endpoints

| Method & path                            | Auth    | Effect                                              |
| ---------------------------------------- | ------- | --------------------------------------------------- |
| `POST /v1/connector-catalog`             | admin   | verify signature → store `pending` (bad sig → 400)  |
| `GET /v1/connector-catalog`              | admin   | list all catalogs (newest first)                    |
| `POST /v1/connector-catalog/:id/approve` | admin   | `pending → active`, supersede prior active          |
| `POST /v1/connector-catalog/:id/reject`  | admin   | `pending → rejected`                                |
| `GET /v1/connector-catalog/active`       | machine | the active `{version,payload,signature}` or **204** |
