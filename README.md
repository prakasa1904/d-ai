# D-AI

Custom React frontend for a local Casdoor + Casibase + OpenMeter + ClickHouse stack. It includes Casdoor login and registration, Casibase chat, editable chat history, streaming steer/stop controls, usage dashboard, token management, OpenMeter-backed usage metering, ClickHouse-backed request logs, optional token limits, user profile management, and a local OpenAI-compatible chat endpoint.

## Prerequisites

- Docker and Docker Compose.
- Node.js 20 or newer.
- npm.
- Local hostnames:

```text
127.0.0.1 casdoor.local
127.0.0.1 casibase.local
```

## Bootstrap

Run the combined bootstrap script:

```bash
cd /Users/nedya.prakasa/Projects/casibase
./scripts/bootstrap.sh
```

The script checks Docker, Docker Compose, Node.js, and npm; adds `casdoor.local` and `casibase.local` to `/etc/hosts` when missing; starts services in dependency order; waits for databases and HTTP endpoints; runs the Casdoor and Casibase MinIO seeds; restarts Casibase; installs/builds D-AI; and starts the D-AI dev server on port `5174`.

If `/etc/hosts` is missing the local names, the script may ask for your sudo password. To manage hosts manually or skip that step:

```bash
./scripts/bootstrap.sh --skip-hosts
```

Useful options:

```bash
./scripts/bootstrap.sh --no-start-dai
./scripts/bootstrap.sh --no-dai
DAI_PORT=5175 ./scripts/bootstrap.sh
```

Stop the D-AI frontend:

```bash
./scripts/stop-dai.sh
DAI_PORT=5175 ./scripts/stop-dai.sh
```

Open the URL printed by Vite. The usual local URL is:

```text
http://localhost:5174/
```

Vite may use `5173` if that port is available.

OpenMeter is required for D-AI token usage metering and customer-entitlement quota checks. D-AI request audit logs are shipped by OpenTelemetry Collector into ClickHouse. See [OpenMeter Integration](docs/openmeter-integration.md) and [Logging Storage Options](docs/logging-storage-options.md).

## Seeded Local Data

The seed scripts are idempotent and can be re-run safely while the matching database containers are running.

Seed files:

```text
scripts/seed-casdoor.sh
scripts/seed-casdoor.sql
scripts/seed-casibase-minio-store.sh
scripts/seed-casibase-minio-store.sql
```

The seeds create or update:

```text
Organization: ifm
Application: built-in/casibase
Default user: ifm/user
Default password: user
Casdoor storage provider: admin/provider-storage-ifm-minio-v1
Casibase shared store: admin/ifm-v0
Casibase MinIO demo store: admin/ifm-minio-v0
```

The MinIO provider is also bound to the `built-in/casibase` Casdoor application. File upload/delete operations depend on that application-provider binding; a standalone provider record is not enough.

D-AI hardcodes normal user login to Casdoor organization `ifm`, so the login page only asks for username and password.
The same hidden organization is used by the register form, so new users are created under `ifm`.
Registration only asks for display name, username, and password. Email can be added later from `Profile`; sending email during Casdoor signup requires a verification-code flow.

Default D-AI login:

```text
Username: user
Password: user
```

The seeded Casdoor application matches Casibase config:

```text
Application name: casibase
Application owner: built-in
Client ID: ba3a96dbc430c5c6a22b
Client secret: 9228f4ce27971ca5c188cac7489dc0f304a122b6
Redirect URL: http://casibase.local:14000/callback
```

These values are also configured in:

```text
conf/casibase/app.conf
docker-compose.yml
```

## D-AI Configuration

Default local targets:

```text
Casdoor target:  http://casdoor.local:8000
Casibase target: http://casibase.local:14000
MinIO API:       http://localhost:9000
MinIO console:   http://localhost:9001
OpenMeter API:   http://localhost:48888
D-AI logs SQL:   http://localhost:18123
Shared store:    admin/ifm-v0
```

Default MinIO credentials for local development:

```text
Username: minioadmin
Password: minioadmin
Bucket:   casibase
```

The Vite dev server proxies browser calls:

```text
/casdoor  -> http://casdoor.local:8000
/casibase -> http://casibase.local:14000
```

D-AI also adds local Vite middleware routes:

```text
/api/d-ai/casdoor-token       Exchanges a Casdoor OAuth code for a profile access token
/api/d-ai/upload-file         Uploads chat attachments into the configured Casibase store
/api/d-ai/token-state         Reads the signed-in user's D-AI token metadata
/api/d-ai/token-action        Mutates token metadata and syncs OpenMeter customer entitlements
/api/d-ai/token-limit-check   Checks OpenMeter customer-entitlement token limits before browser chat sends to Casibase
/api/d-ai/token-metrics       Returns OpenMeter-backed token dashboard metrics
/api/d-ai/token-request-logs  Returns ClickHouse-backed token request audit logs
/api/v1/models                Lists the D-AI OpenAI-compatible model ID
/api/v1/histories             Lists API histories for the bearer token
/api/v1/history               Gets one API history by key, including messages when available
/api/v1/chat/completions      OpenAI-compatible chat endpoint with stable history-key support
```

Optional `.env.local` overrides:

```bash
VITE_PORT=5173
VITE_CASDOOR_TARGET=http://casdoor.local:8000
VITE_CASIBASE_TARGET=http://casibase.local:14000
VITE_CASDOOR_BASE=/casdoor
VITE_CASIBASE_BASE=/casibase
VITE_CASDOOR_CLIENT_ID=ba3a96dbc430c5c6a22b
VITE_CASDOOR_CLIENT_SECRET=9228f4ce27971ca5c188cac7489dc0f304a122b6
VITE_CASDOOR_APPLICATION=casibase
VITE_CASDOOR_REDIRECT_URI=http://casibase.local:14000/callback
VITE_CASDOOR_SCOPE=profile
VITE_CASIBASE_SHARED_STORE_ID=admin/ifm-v0
D_AI_UPLOAD_ADMIN_ORGANIZATION=built-in
D_AI_UPLOAD_ADMIN_USERNAME=admin
D_AI_UPLOAD_ADMIN_PASSWORD=123
OPENMETER_ENABLED=true
OPENMETER_BASE_URL=http://localhost:48888
OPENMETER_API_TOKEN=
OPENMETER_METER_SLUG=tokens_total
OPENMETER_REQUEST_METER_SLUG=requests_total
OPENMETER_PROMPT_METER_SLUG=prompt_tokens_total
OPENMETER_COMPLETION_METER_SLUG=completion_tokens_total
OPENMETER_COST_METER_SLUG=cost_total
OPENMETER_EVENT_TYPE=prompt
OPENMETER_EVENT_SOURCE=d-ai
OPENMETER_SUBJECT_MODE=token
OPENMETER_ENTITLEMENTS_ENABLED=true
OPENMETER_TOTAL_TOKENS_FEATURE_KEY=d_ai_token_quota
OPENMETER_REQUESTS_PER_MINUTE_FEATURE_KEY=d_ai_minute_requests
OPENMETER_REQUESTS_PER_HOUR_FEATURE_KEY=d_ai_hourly_requests
OPENMETER_TOKENS_PER_DAY_FEATURE_KEY=d_ai_daily_tokens
OPENMETER_REQUESTS_PER_DAY_FEATURE_KEY=d_ai_daily_requests
OPENMETER_TOTAL_TOKENS_ENTITLEMENT_PERIOD=P100Y
OPENMETER_FAIL_CLOSED=true
D_AI_AUDIT_LOG_ENABLED=true
D_AI_AUDIT_LOG_FILE=.d-ai-state/logs/request-audit.jsonl
D_AI_CLICKHOUSE_LOGS_ENABLED=true
D_AI_CLICKHOUSE_LOGS_URL=http://localhost:18123
D_AI_CLICKHOUSE_LOGS_USERNAME=default
D_AI_CLICKHOUSE_LOGS_PASSWORD=default
D_AI_CLICKHOUSE_LOGS_DATABASE=d_ai_logs
D_AI_CLICKHOUSE_LOGS_TABLE=otel_logs
```

`VITE_CASDOOR_CLIENT_SECRET` is used by the local Vite middleware for development profile updates. Do not expose this dev middleware directly to untrusted clients.
`D_AI_UPLOAD_ADMIN_*` is used only by the local Vite middleware to call Casibase file upload APIs that require admin privilege. Replace it with a service account or a tighter backend permission model before production.
For D-AI backend + OpenMeter usage metering and quota checks, see [OpenMeter Integration](docs/openmeter-integration.md). For the difference between Casdoor pricing and OpenMeter entitlements, see [Casdoor Pricing vs OpenMeter Entitlements](docs/casdoor-vs-openmeter-entitlements.md). For OpenTelemetry + ClickHouse audit logging, see [Logging Storage Options](docs/logging-storage-options.md).

## Useful Commands

```bash
cd /Users/nedya.prakasa/Projects/casibase/d-ai
npm install
npm run dev
npm run build
npm run preview
```

Restart `npm run dev` after changing `vite.config.js`, server middleware, or `.env.local`.

## App Features

- Login page: sign in with a Casdoor user or register a new `ifm` user without exposing the organization field.
- Chat page: create new chats, upload image attachments into the selected Casibase store, forward image metadata into prompts, open history, rename chats, delete chats, and stop or steer an active streaming response.
- Dashboard page: view signed-in user chat and message usage.
- Tokens summary page (`/tokens`): create/copy/delete/activate/deactivate D-AI tokens, monitor fleet-level request success rate, failed requests, failure breakdown, token usage, and open token details.
- Token detail page (`/tokens/{token-id}`): inspect one token's metadata, API reference, OpenMeter-backed rate limits, usage charts, failure charts, and ClickHouse-backed request logs.
- Profile page: update Casdoor profile fields such as display name, avatar, contact info, work info, preferences, and bio.

Profile updates require a Casdoor access token. New logins obtain it automatically. If you were already signed in before this feature was added, open `Profile`, enter your current password in `Confirm Access`, and save again.

Casibase can still generate its own chat titles, such as `New Chat - 1`, after a conversation is created. Use the sidebar rename or delete actions to manage those chat history entries.

Chat attachments are intentionally limited to images in D-AI. Casibase's document/vector indexer does not support image extensions such as `.jpeg`, so D-AI stores the image and sends image metadata/URL context to the chat instead of treating the upload as a text document. Image understanding still depends on the selected Casibase model provider: use a vision-capable model, and make sure the image URL is reachable by that model runtime.

D-AI token metadata is handled by the local middleware in development. Usage metrics, request metrics, and quota entitlement values come from OpenMeter. Detailed request audit logs are written outside token state and shipped to ClickHouse by OpenTelemetry Collector. For ownership boundaries, local persistence, security, and production guidance, see [Application Responsibilities](docs/application-responsibilities.md).

For `/api/v1/chat/completions`, reuse the same `X-D-AI-History-Key` header to append requests to the same Casibase chat history. If the header is omitted, D-AI uses `default`, so each token has one stable default API conversation. Use a different history key only when you want a separate API conversation.

For CLI behavior such as `openclaw`, see [API History For CLI Apps](docs/api-history-for-cli-apps.md).

## Model Provider Versioning

Treat Casibase provider names as stable IDs after users start chatting. Casibase persists the provider name on chat and message rows, so renaming or deleting a provider that already has history can break old conversations with errors such as:

```text
The model provider: dummy-model-provider is not found
```

For model changes, create a new provider record, for example `ifm-v2`, and point the shared store to that new provider. Keep the old provider record available while old chats still exist, or migrate old chat/message rows intentionally. D-AI repairs stale chat history to the current store provider before sending, but the safest operational pattern is provider versioning instead of renaming an in-use provider.

## Store Naming

Treat the Casibase store `name` as a stable ID too. D-AI loads exactly one shared store from `VITE_CASIBASE_SHARED_STORE_ID`, such as `admin/ifm-v0`. If you rename the store `name` in Casibase, update `VITE_CASIBASE_SHARED_STORE_ID` and restart `npm run dev`; otherwise the chat page will not have a store to select. For a label-only change, edit the store display name instead of the store name.

## Store Storage

A Casibase store is the workspace used for chat, uploaded files, retrieval settings, and provider bindings. The store `storageProvider` controls where files are persisted. The current local store uses MinIO:

```text
Store:            admin/ifm-v0
Storage provider: provider-storage-ifm-minio-v1
Storage type:     MinIO
Storage subpath:  ifm-v0
```

The optional MinIO demo store uses:

```text
Store:            admin/ifm-minio-v0
Display name:     IFM MinIO v0
Storage provider: provider-storage-ifm-minio-v1
Storage type:     MinIO
Storage subpath:  ifm-minio-v0
```

Casibase also supports distributed object storage providers through Casdoor, including `AWS S3`, `MinIO`, `Aliyun OSS`, `Tencent Cloud COS`, `Azure Blob`, `Qiniu Cloud Kodo`, and `Google Cloud Storage`. This docker compose file includes `minio/minio:latest` to demonstrate S3-compatible distributed storage locally.

Important: in Casibase `Providers`, `Storage` only shows `Local File System` and `OpenAI File System`. That is expected. Create S3-compatible providers in Casdoor first, then select that provider in the Casibase Store edit page.

Local MinIO demo:

```text
Service:     minio
Image:       minio/minio:latest
S3 endpoint: http://minio:9000
Console:     http://localhost:9001
Access key:  minioadmin
Secret key:  minioadmin
Bucket:      casibase
```

The `minio-init` service creates the `casibase` bucket automatically.

Simple MinIO setup with Casdoor and Casibase:

1. Start MinIO:

```bash
docker compose up -d minio minio-init
```

2. Run the Casdoor seed if you want the local MinIO provider created automatically:

```bash
./scripts/seed-casdoor.sh
```

3. The seed creates this Casdoor provider:

```text
Owner:            admin
Name:             provider-storage-ifm-minio-v1
Category:         Storage
Type:             MinIO
Client ID:        minioadmin
Client secret:    minioadmin
Endpoint:         http://minio:9000
Intranet endpoint: http://minio:9000
Domain:           http://minio:9000
Bucket:           casibase
Path prefix:      ifm-v0
State:            Active
```

4. To create it manually instead, open Casdoor at `http://casdoor.local:8000`, log in as an admin, open `Providers`, and add a `Storage` provider with `Type` set to `MinIO`.
5. Open Casibase at `http://casibase.local:14000`.
6. Run the Casibase MinIO store seed to move the active shared store to MinIO:

```bash
./scripts/seed-casibase-minio-store.sh
```

7. Or do it manually: open `Stores`, edit `admin/ifm-v0`, and set `Storage provider` to `provider-storage-ifm-minio-v1`.
8. Set `Storage subpath` to a stable prefix such as `ifm-v0`.
9. Upload a small test file through the store UI.
10. Open the MinIO console at `http://localhost:9001` and verify the object appears under the `casibase` bucket.

If you want a separate store row instead of changing `admin/ifm-v0`, run:

```bash
./scripts/seed-casibase-minio-store.sh
```

This also creates a separate demo store row. Open `Stores` and use `admin/ifm-minio-v0` / `IFM MinIO v0` if you want to test MinIO without changing chats on `admin/ifm-v0`.

If `admin/ifm-v0` already has uploaded files in the old local filesystem storage, do not only switch the provider. First copy `/files/<old-storage-subpath>` from the Casibase container into the MinIO bucket under the new subpath, then verify downloads before removing the old files. In the default local stack above, there are no uploaded files yet, so the provider switch is enough.

Simple S3 setup:

1. Create an S3 bucket, for example `ifm-casibase-dev`.
2. Create an IAM access key with read/write permission for that bucket.
3. In Casdoor, open `Providers` and add a storage provider.
4. Set `Category` to `Storage` and `Type` to `AWS S3`.
5. Use a stable provider name, for example `provider-storage-ifm-s3-v1`.
6. Fill `Client ID` with the S3 access key ID.
7. Fill `Client secret` with the S3 secret access key.
8. Fill `Region` with the bucket region, for example `ap-southeast-1`.
9. For AWS S3, leave the custom endpoint empty unless your deployment requires one. For S3-compatible storage such as MinIO, use `Type: MinIO` and set the intranet endpoint to the URL reachable from the Docker network, for example `http://minio:9000`.
10. Save the provider and keep it `Active`.
11. Open `Stores`, edit `admin/ifm-v0`, and set `Storage provider` to the new provider.
12. Set `Storage subpath` to a stable prefix such as `ifm-v0`.
13. Upload a small test file through the store UI and verify the object appears in the bucket.

Operational notes:

- If upload or delete fails with `No provider for category: Storage is found for application: casibase`, rerun `./scripts/seed-casdoor.sh` and restart `casdoor` plus `casibase`. The MinIO provider must be bound to the Casdoor `casibase` application, not only created as a provider row.
- The Casibase container must be able to reach the S3 or MinIO endpoint, not only your browser.
- Create the bucket before using it unless your storage policy explicitly allows auto-creation.
- Do not rename an in-use storage provider or store name. Create a new provider, for example `provider-storage-ifm-s3-v2`, then switch the store intentionally.
- Switching storage providers does not automatically move old files. Keep the old provider available or migrate objects between storage backends before removing it.
- Keep S3 credentials out of Git. Configure them in Casibase provider data or a secret-management path for production.

## Token Limits

Token quotas are optional when creating a token. Leave the entitlement field blank, or set any limit to `0`, when you do not want that cap:

- Requests per minute, synced to an OpenMeter customer entitlement.
- Requests per hour, synced to an OpenMeter customer entitlement.
- Requests per day, synced to an OpenMeter customer entitlement.
- Tokens per day, synced to an OpenMeter customer entitlement.
- Token entitlement quota, synced to an OpenMeter customer entitlement.

D-AI uses OpenMeter customer entitlement APIs, not the deprecated subject entitlement APIs. With the default token subject mode, each D-AI token maps to one OpenMeter customer key such as `dai_token_tok_...`.

## Chat Completions API

The local Vite server exposes an OpenAI-compatible endpoint:

```text
POST http://localhost:5174/api/v1/chat/completions
```

Example:

```bash
curl 'http://localhost:5174/api/v1/chat/completions' \
  -H 'Authorization: Bearer <D_AI_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'X-D-AI-History-Key: openclaw:casibase:debug-login' \
  --data '{
    "model": "d-ai-casibase",
    "messages": [{"role": "user", "content": "Hello from D-AI"}],
    "stream": true
  }'
```

For CLI clients, use a new `X-D-AI-History-Key` per task or session, and reuse it when the user continues the same task. API clients can discover the available model and token histories:

```bash
curl 'http://localhost:5174/api/v1/models' \
  -H 'Authorization: Bearer <D_AI_TOKEN>'

curl 'http://localhost:5174/api/v1/histories' \
  -H 'Authorization: Bearer <D_AI_TOKEN>'

curl 'http://localhost:5174/api/v1/history?key=openclaw%3Acasibase%3Adebug-login' \
  -H 'Authorization: Bearer <D_AI_TOKEN>'
```

Tokens are loaded from the D-AI backend after sign-in. If a new token is rejected by curl, refresh D-AI once while signed in and try again. The local state file stores token identity and status only. OpenMeter is the source for usage metrics, request metrics, quota limit values, and customer-entitlement quota decisions, and ClickHouse is the local audit log store. See [Application Responsibilities](docs/application-responsibilities.md).

## Production Note

The local `/api/d-ai/*` and `/api/v1/*` routes are Vite middleware for development. See [Application Responsibilities](docs/application-responsibilities.md) before exposing them to real clients.

## Troubleshooting

If login fails, re-run the seed and restart Casibase:

```bash
./scripts/seed-casdoor.sh
docker compose restart casibase
```

If curl returns `404` for `/api/v1/chat/completions`, restart the Vite dev server because `vite.config.js` defines that local route.

If registration returns `The verification code has not been sent yet!`, refresh D-AI and restart `npm run dev`. The D-AI register form should not ask for email during initial signup; add email later from `Profile`.

If profile save returns `Unauthorized operation`, refresh `/profile`. If the `Confirm Access` panel appears, enter the current Casdoor password once and save again. If the route still fails, restart the Vite dev server so `/api/d-ai/casdoor-token` is available.
