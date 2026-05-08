# OpenMeter Integration

This document explains the D-AI backend + OpenMeter design used by the local stack.

## Responsibility

D-AI still owns API token lifecycle:

- Token creation and deletion.
- Token secret generation.
- Active or inactive state.
- Per-token metadata shown in the UI.
- Deterministic routing from API tokens and history keys to Casibase chat histories.

OpenMeter owns metered usage:

- Success and failure request events from D-AI.
- Aggregated token usage and request metrics by subject.
- Queryable usage, request, and cost totals for token dashboard metrics.
- Queryable quota counters for total tokens, daily tokens, and request limits.
- Optional entitlement or billing workflows outside the current local prototype.

Casdoor remains the identity provider, and Casibase remains the chat, store, model, message, and file engine.

## Local OpenMeter Stack

The main `docker-compose.yml` includes OpenMeter as a required local service group. It is started by the normal bootstrap instructions in `README.md`.

Start or restart OpenMeter locally:

```bash
cd /Users/nedya.prakasa/Projects/casibase
docker compose up -d openmeter openmeter-sink-worker openmeter-balance-worker
```

OpenMeter API:

```text
http://localhost:48888
```

The local config is:

```text
conf/openmeter/config.yaml
```

That config defines these meters:

```text
tokens_total             SUM $.tokens
prompt_tokens_total      SUM $.prompt_tokens
completion_tokens_total  SUM $.completion_tokens
requests_total           SUM $.request_count
cost_total               SUM $.price
```

The D-AI token dashboard queries these OpenMeter meters through the backend endpoint `/api/d-ai/token-metrics`. Detailed request log tables are intentionally separate and use ClickHouse through `/api/d-ai/token-request-logs`.

## D-AI Environment

OpenMeter is enabled by default in the local D-AI middleware. These are the default `d-ai/.env.local` values:

```bash
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
OPENMETER_FAIL_CLOSED=false
```

Restart D-AI after changing this file:

```bash
cd /Users/nedya.prakasa/Projects/casibase/d-ai
npm run dev
```

For OpenMeter Cloud, set `OPENMETER_BASE_URL` to the cloud endpoint and put the OpenMeter token in `OPENMETER_API_TOKEN`.

## Event Shape

When a chat request succeeds with a selected D-AI token, D-AI sends one CloudEvents batch item to OpenMeter:

```json
{
  "source": "d-ai",
  "specversion": "1.0",
  "type": "prompt",
  "subject": "dai_token_tok_...",
  "data": {
    "request_count": 1,
    "tokens": 123,
    "prompt_tokens": 45,
    "completion_tokens": 78,
    "price": 0,
    "model": "provider-name",
    "type": "total",
    "source": "api",
    "status": "success",
    "http_status": 200,
    "token_id": "tok_...",
    "history_key": "default"
  }
}
```

Failed token requests are also emitted to OpenMeter with `request_count: 1`, `status: "failed"`, an HTTP status, and error fields. Failed requests use `tokens: 0` so they affect reliability metrics without consuming token quota.

With `OPENMETER_SUBJECT_MODE=token`, each D-AI token gets its own OpenMeter subject.
With `OPENMETER_SUBJECT_MODE=account`, all tokens for the same Casdoor account share one subject and quota pool.

## Quota Checks

When checking token quotas, D-AI uses OpenMeter for metered totals:

- `totalTokens` is checked against the OpenMeter meter total for the token subject.
- `tokensPerDay` is checked against the OpenMeter meter total since the start of the current day.
- Request count limits such as requests per minute, hour, and day are checked against the OpenMeter `requests_total` meter.

Quota checks use OpenMeter totals. D-AI token state does not store usage logs or quota counters.

If `OPENMETER_FAIL_CLOSED=true`, quota checks fail when OpenMeter cannot be queried.
If it is `false`, D-AI fails open for development convenience. Do not use fail-open quota checks for production.

## Verify Usage

After using a D-AI token, query OpenMeter directly:

```bash
curl 'http://localhost:48888/api/v1/meters/tokens_total/query?subject=dai_token_<TOKEN_ID>'
curl 'http://localhost:48888/api/v1/meters/requests_total/query?subject=dai_token_<TOKEN_ID>&windowSize=DAY&groupBy=status&groupBy=http_status'
```

For OpenMeter Cloud, include:

```bash
-H 'Authorization: Bearer <OPENMETER_API_TOKEN>'
```

## Production Direction

For production, keep D-AI as a real backend service with a database for token records and token metadata. Use OpenMeter for durable metering, request analytics, quota checks, entitlements, billing, and customer-level usage reporting.

Recommended storage split:

- D-AI database, usually Postgres or MySQL: token records, hashed token secrets, token limit configuration, and a metering outbox for retrying failed OpenMeter event delivery.
- OpenMeter: usage totals, request totals, failure metrics, quota counters, and billing/entitlement reporting.
- ClickHouse or another audit/log store: detailed request logs for debugging or compliance, kept outside the token metadata table.

Do not rely on `d-ai/.d-ai-state/tokens.json` for production token storage or metrics.
