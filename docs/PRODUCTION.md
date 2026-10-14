# Deploying Helix Foundry for an organization

This guide takes Helix Foundry from a single-computer install to a shared
service your team signs in to: multi-user accounts, document intelligence
(entity graphs + semantic search), durable storage, and a validation
checklist. For day-to-day operating tasks see [OPERATIONS.md](OPERATIONS.md);
for the product tour see [GUIDE.md](GUIDE.md).

## What you get

- **Sign-in for your team.** `REQUIRE_LOGIN=true` replaces the local
  single-user identity with email+password accounts, workspace roles
  (owner/editor/viewer), and an audit log of security events.
- **Documents as data.** PDF, DOCX, text, Markdown and image uploads are
  extracted to rows. With "Extract entities and topics" checked, the AI
  provider also produces an **entities dataset** (who/what/where per page)
  and a **semantic dataset** (embeddings per row).
- **Graph + vector.** Structured datasets become ontology objects and link
  types in HelixDB's graph. Document embeddings live in Parquet next to the
  data and are ranked with DuckDB `array_cosine_similarity` — no separate
  vector database to run.
- **Answer questions.** The Analyst plans SQL over Parquet snapshots; for
  document corpora it also receives the most relevant document excerpts in
  context. `POST /api/v1/workspaces/:w/semantic` gives direct semantic search.
- **Durable by default.** HelixDB holds the ontology, workspaces, members,
  sessions and provider settings; Parquet snapshots hold data; both survive
  restarts, and snapshots/backups can live in S3 or Azure Blob.

## 1. Deploy on an EC2 host

Amazon Linux 2023 or Ubuntu, ≥8 GB RAM (16 GB recommended), Docker + Compose
plugin.

```sh
git clone https://github.com/helixdb/helix-foundry.git
cd helix-foundry
./scripts/setup.sh            # writes .env with ENCRYPTION_KEY + INTERNAL_KEY
```

Edit `.env`:

```env
PUBLIC_PORT=80                        # or 3001 behind your own proxy
PUBLIC_ORIGIN=http://foundry.internal.example.com   # URL people will use
REQUIRE_LOGIN=true                    # enable sign-in
```

`PUBLIC_ORIGIN` matters: the API only accepts requests for that host, and
session cookies are marked `Secure` automatically when it starts with
`https:`.

```sh
docker compose up -d --build          # hosted AI only
# or, to run models on the host too:
docker compose --profile local up -d --build
```

Wait for health:

```sh
curl -fsS http://localhost:80/api/health
# {"ok":true,"service":"helix-foundry"}
```

TLS: put the container behind your usual terminator (ALB, nginx, Caddy) and
set `PUBLIC_ORIGIN=https://your-domain`. HelixDB, the executor and Ollama
publish no ports; only the app container is exposed, on loopback by default —
publish it through your proxy.

## 2. First sign-in and members

1. Open `PUBLIC_ORIGIN` — you get the **first-account screen** (shown only
   while no password user exists). Create your account; it becomes the owner
   of a new workspace.
2. **Settings → People & access → Add a teammate**: enter their email, a
   role, and a first password for new accounts. Share the password
   directly — there is no email invite flow.
3. Roles: **viewer** reads, **editor** changes data and ontology, **owner**
   also manages members, provider settings and API tokens. The last owner
   cannot be removed or demoted.
4. **Settings → People & access → Your account**: password change and
   sign-out. Sessions last 7 days; the cookie is HttpOnly, SameSite=Lax, and
   Secure on HTTPS origins.

API access stays the same for scripts: `Authorization: Bearer <token>` with
tokens from **Settings → Developer tools**. Sign-in sessions also work as
`Authorization: Bearer <session>`.

Audit: `GET /api/v1/workspaces/:w/audit` (owner) lists logins, failed logins,
member changes and password changes, newest first.

## 3. Configure AI

**Settings → AI & models** per workspace. All settings are stored encrypted
(AES-256-GCM with `ENCRYPTION_KEY`).

| Provider | Fields | Notes |
|---|---|---|
| Local (Ollama) | Model, **Ollama endpoint** | Default endpoint `OLLAMA_URL`; per-workspace `baseUrl` overrides it and is validated live (`/api/tags` + a structured call). Semantic search defaults to `nomic-embed-text` — pull it once: `docker exec <ollama> ollama pull nomic-embed-text` or `ollama pull` on native installs. |
| Anthropic Claude | API key, model | No embeddings API — semantic search is unavailable; document entity extraction still works. |
| OpenAI | API key, model | Embeddings default `text-embedding-3-small`. |
| AWS Bedrock | Model, region, credential mode | **IAM role** (optional role ARN to assume, else instance role/env), **long-term keys**, or **temporary credentials** (with session token). Any Converse-capable model ID works — e.g. `us.amazon.nova-pro-v1:0`, `us.amazon.nova-lite-v1:0`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. Embeddings default `amazon.titan-embed-text-v2:0`. |
| Azure OpenAI | Endpoint, deployment (model), API key | Semantic search also needs an **embeddings deployment name** (`embedModel`), e.g. your `text-embedding-3-small` deployment. |

`embedModel` can be set per workspace through the provider API
(`PUT /api/v1/workspaces/:w/provider`) if you prefer a different embedding
model/deployment.

## 4. Build the ontology from documents

1. **Data → Add data → Upload files**, keep "Extract entities and topics"
   checked, upload PDF/DOCX/TXT/MD/images.
2. Each document becomes **three datasets**: `<name>` (`{page, text}`),
   `<name> — entities` (`{page, entity, type, context}`), and
   `<name> — semantic` (`{page, text, embedding}`).
3. On the **Ontology** step, the suggester treats entities as ordinary
   data — propose Entity object types and link them (document page →
   entity). Confirm and publish.
4. The **graph view** then shows documents clustered by shared entities, and
   questions get semantic excerpts automatically.

For hundreds of documents this is the intended path: entities give the graph
joinable keys; embeddings give retrieval without a vector database.

## 5. Durability and backups

Two things persist, on Docker named volumes by default:

| Volume | Holds |
|---|---|
| `helix-foundry_helix-data` | Workspaces, ontology, members, sessions, provider settings, records |
| `helix-foundry_foundry-data` | Uploads, Parquet snapshots, results |

- `SNAPSHOT_URI=s3://bucket[/prefix]` or `azure://container[/prefix]` moves
  dataset snapshots to object storage (`SNAPSHOT_REGION`,
  `SNAPSHOT_ACCESS_KEY_ID`, `SNAPSHOT_SECRET_ACCESS_KEY`,
  `SNAPSHOT_ENDPOINT` for MinIO-style stores).
- `./scripts/backup.sh --to s3://bucket/foundry` / `--to azure://container`
  uploads a backup; `restore.sh` takes the same URIs.
- Backups hold `ENCRYPTION_KEY` encrypted with your passphrase — losing both
  the key and backups makes stored credentials unreadable. Keep `.env` safe.

## 6. Validate the deployment

```sh
# Health
curl -fsS http://<host>/api/health

# Sign-in gate works
curl -s http://<host>/api/v1/me                 # 401 until signed in
curl -s http://<host>/api/v1/auth/mode          # {"requireLogin":true,"bootstrap":true}

# Semantic search (after a document upload)
curl -X POST http://<host>/api/v1/workspaces/<w>/semantic \
  -H 'authorization: Bearer <session>' -H 'content-type: application/json' \
  -d '{"query":"what does the guide say about subclasses","k":5}'

# Audit trail (owner)
curl -s http://<host>/api/v1/workspaces/<w>/audit -H 'authorization: Bearer <session>'
```

In the browser: sign in, complete setup (AI → Data → Ontology), upload a
document, open the graph view, and ask a question whose answer lives in the
document — the run's context includes the matching excerpts.

## 7. Windows development without Docker

`HELIX_EMBEDDED=true` runs HelixDB inside the API process (native library,
data in `.data/helix`) — `npm run dev` then starts everything, no containers.
One process per data directory: keep `INLINE_WORKER` default; don't run
`pnpm start` + `pnpm worker` side by side. This is a development mode; the
team deployment above stays on the Compose stack.

## Known boundaries

- Rate limiting is per-process (240 req/min default, 10/min on login); run
  one API replica or set `RATE_LIMIT_MAX` accordingly.
- Login is password-based local auth. Enterprise SSO/OIDC is the next seam
  (session issuance is already isolated in `auth.ts`).
- Scanned PDFs without a text layer fail extraction with a clear error;
  OCR covers image files only.
- Vector search scans the semantic table per query (fine at tens of
  thousands of rows); an approximate index is future work if corpora grow.
