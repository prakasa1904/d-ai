# D-AI Data Sources

This document maps each visible D-AI UI feature to the data source that backs it.

The D-AI React UI reads backend-origin data from Casdoor, Casibase, D-AI middleware, OpenMeter, and ClickHouse. Product data is not cached as a frontend source of truth.

## Storage Summary

| Storage | Used for | Development location | Production recommendation |
| --- | --- | --- | --- |
| Casdoor MySQL | Users, passwords, registration, profile fields, organizations, applications, and storage provider metadata | Docker volume `casdoor_db_data` | Managed Casdoor database |
| Casibase MySQL | Stores, chats, messages, file tree records, model provider references, and store provider bindings | Docker volume `casibase_db_data` | Managed Casibase database |
| MinIO | Uploaded file bytes used by Casibase storage providers | Docker volume `minio_data`, bucket `casibase` | S3 or another S3-compatible object store |
| D-AI local state file | D-AI token metadata, token status, raw development token values, Casibase session-cookie bindings, and backend-held Casdoor profile access tokens | `d-ai/.d-ai-state/tokens.json` | Move to a real D-AI backend database; store token secrets hash-only after creation and keep OAuth tokens encrypted |
| OpenMeter | Usage meters, request meters, customer entitlements, quota limit values, and quota checks | OpenMeter Kafka, ClickHouse, Postgres, and Redis volumes | Managed OpenMeter deployment |
| D-AI audit JSONL | Local file collected by OpenTelemetry before ClickHouse ingestion | `d-ai/.d-ai-state/logs/request-audit.jsonl` | Replace with direct OTLP/log pipeline where possible |
| D-AI ClickHouse | Detailed token request audit logs shown in token request tables | Docker volume `d_ai_clickhouse_data`, database `d_ai_logs` | ClickHouse, OpenSearch, or another dedicated log store |

## UI Data Map

| UI data | Screen/component | API endpoint or client function | Source of truth | How it is calculated |
| --- | --- | --- | --- | --- |
| Chat history list | Chat sidebar | Casibase `/api/get-chats` through `getChats(account)` | Casibase chats table | Filtered by signed-in Casibase user and sorted by Casibase timestamps |
| Chat messages | Chat page | Casibase `/api/get-messages` through `getMessages(chat)` | Casibase messages table | Messages are created with `/api/add-message`; model answers stream from `/api/get-message-answer` |
| Chat dashboard totals | `/dashboard` | Casibase chat/message reads | Casibase chats and messages | UI counts chats, messages, prompts, answers, words, and activity in the selected period |
| Shared store | Chat page | Casibase `/api/get-store?id=admin/ifm-v0` | Casibase store record | D-AI loads the configured shared store and uses its model/storage provider bindings |
| File uploads | Chat page upload control | D-AI `/api/d-ai/upload-file` -> Casibase `/api/add-tree-file` | Casibase file records plus MinIO object bytes | D-AI accepts image files only, uploads through an admin Casibase session, and sends image metadata/URL context to chat |
| Profile | `/profile` | D-AI `/api/d-ai/profile` proxying Casdoor `/api/get-user` and `/api/update-user` | Casdoor user profile; backend-held access token in D-AI state | D-AI stores the Casdoor access token server-side for the signed-in account and never stores it in the React UI |
| Tokens list | `/tokens` | `/api/d-ai/token-state` | `d-ai/.d-ai-state/tokens.json` | Returns token metadata for the signed-in Casibase account |
| Token secret | Token list/detail | `/api/d-ai/token-state` | D-AI local state | Development keeps `dai_...` values so the UI can copy them; production should show secrets once |
| Token active/inactive | Token list/detail | `/api/d-ai/token-action` action `toggle-token` | D-AI local state | D-AI validates token status before proxying `/api/v1/*` calls |
| Token limits | Create/edit token | `/api/d-ai/token-action` actions `create-token`, `update-token-limits` | OpenMeter customer entitlements | D-AI syncs limit values to OpenMeter customer-based entitlement APIs |
| Rate limit tracker | Token detail | `/api/d-ai/token-metrics` | OpenMeter customer entitlements and meters | OpenMeter returns observed usage and entitlement snapshots for the token customer |
| Attempts | Token summary/detail stats | `/api/d-ai/token-metrics` | OpenMeter request meter | Request events are summed by period and token |
| Success rate | Token summary/detail stats and line chart | `/api/d-ai/token-metrics` | OpenMeter request meter | `success / requests * 100`, grouped by selected period |
| Failed requests | Token summary/detail stats and line chart | `/api/d-ai/token-metrics` | OpenMeter request meter | Failed request count, grouped by selected period |
| Failed requests by status code | Token monitoring chart | `/api/d-ai/token-metrics.failedStatusChart` | OpenMeter request meter dimensions | Failed requests grouped by HTTP status code and period bucket |
| Failure breakdown | Token summary/detail | `/api/d-ai/token-metrics.failureBreakdown` | OpenMeter request meter dimensions | Top `error_type` or `failure_stage` values in the selected period |
| Token usage over time | Token summary/detail | `/api/d-ai/token-metrics.usageSeries` | OpenMeter token meters | Prompt, completion, total token, and optional cost meters bucketed by period |
| Recent token requests | `/tokens` | `/api/d-ai/token-request-logs?tokenId=all` | D-AI ClickHouse audit log table | Latest structured request audit rows for the signed-in account's tokens |
| Token Request Log | `/tokens/{tokenId}` | `/api/d-ai/token-request-logs?tokenId=<id>` | D-AI ClickHouse audit log table | Same audit log source, filtered to the selected token |
| API histories | `/api/v1/histories`, `/api/v1/history` | D-AI OpenAI-compatible API | Casibase chats and messages | D-AI maps token plus `X-D-AI-History-Key` to a stable Casibase chat name |
| Public API base URL | Token API reference | UI runtime/config | Vite dev server | Shows the local OpenAI-compatible D-AI endpoint clients should call |

## Request Event Flow

Browser chat and OpenAI-compatible API calls both emit metering and audit data.

```text
Browser chat
  -> Casibase chat/message APIs
  -> D-AI records usage to OpenMeter
  -> D-AI writes structured audit JSONL
  -> OpenTelemetry Collector ships JSONL to D-AI ClickHouse
  -> UI reads metrics from OpenMeter and logs from ClickHouse

API client
  -> D-AI /api/v1/chat/completions
  -> D-AI validates dai_... token from local state
  -> D-AI checks OpenMeter entitlements
  -> D-AI sends prompt to Casibase
  -> D-AI records usage/failure to OpenMeter and audit logs
```

Audit log rows contain fields such as:

```text
token_id
token_name
account_owner
account_name
status
source
endpoint
method
history_key_hash
http_status
error_type
error_message
failure_stage
prompt_tokens
completion_tokens
total_tokens
latency_ms
chat_name
model_provider
```

The raw history key is not stored in ClickHouse; D-AI stores a hash for log correlation.

## Quota Data

Quota configuration and quota enforcement use different data:

| Quota item | Configuration source | Enforcement source |
| --- | --- | --- |
| Token active/inactive | D-AI local state | D-AI token validation before Casibase is called |
| Total token quota | OpenMeter customer entitlement | D-AI OpenMeter entitlement check before browser/API calls |
| Requests per minute/hour/day | OpenMeter customer entitlement | D-AI OpenMeter entitlement/request check |
| Tokens per day | OpenMeter customer entitlement | D-AI OpenMeter entitlement/token check |
| Detailed request logs | D-AI ClickHouse | Display and audit only, not quota enforcement |

## What Is Not Stored By D-AI

D-AI does not store Casdoor passwords or identity records. Casdoor owns those.

D-AI does not store Casibase chats, messages, stores, model providers, or file records. Casibase owns those.

D-AI does not store uploaded object bytes. Casibase writes them through the configured storage provider, MinIO in local development.

D-AI local token state is not the source of truth for usage metrics, request metrics, entitlement values, or audit logs.
