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
- Customer-scoped entitlement values for token quota, request quotas, and daily token quota.
- Optional billing workflows outside the current local prototype.

Casdoor remains the identity provider, and Casibase remains the chat, store, model, message, and file engine.

For the difference between Casdoor pricing/subscription data and OpenMeter entitlements, see [Casdoor Pricing vs OpenMeter Entitlements](casdoor-vs-openmeter-entitlements.md).

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
OPENMETER_ENTITLEMENTS_ENABLED=true
OPENMETER_TOTAL_TOKENS_FEATURE_KEY=d_ai_token_quota
OPENMETER_REQUESTS_PER_MINUTE_FEATURE_KEY=d_ai_minute_requests
OPENMETER_REQUESTS_PER_HOUR_FEATURE_KEY=d_ai_hourly_requests
OPENMETER_TOKENS_PER_DAY_FEATURE_KEY=d_ai_daily_tokens
OPENMETER_REQUESTS_PER_DAY_FEATURE_KEY=d_ai_daily_requests
OPENMETER_TOTAL_TOKENS_ENTITLEMENT_PERIOD=P100Y
OPENMETER_FAIL_CLOSED=true
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

## Customer Entitlements

D-AI uses OpenMeter customer entitlements for quota-style limits. It intentionally uses the current customer-scoped APIs:

```text
POST /api/v1/customers
POST /api/v1/features
POST /api/v2/customers/{customerIdOrKey}/entitlements
PUT  /api/v2/customers/{customerIdOrKey}/entitlements/{entitlementIdOrFeatureKey}/override
GET  /api/v2/customers/{customerIdOrKey}/entitlements/{entitlementIdOrFeatureKey}/value
```

Do not use the deprecated subject entitlement APIs such as `/api/v1/subjects/{subjectIdOrKey}/entitlements`.

With the default `OPENMETER_SUBJECT_MODE=token`, D-AI creates one OpenMeter customer per D-AI token and attributes that token's OpenMeter subject to the customer:

```text
D-AI token ID:      tok_...
OpenMeter subject:  dai_token_tok_...
OpenMeter customer: dai_token_tok_...
```

That preserves per-token quotas while using the non-deprecated customer entitlement APIs. If `OPENMETER_SUBJECT_MODE=account` is used, the quota pool is account-scoped instead of token-scoped.

The local stack creates these OpenMeter features on demand:

```text
d_ai_token_quota      -> tokens_total
d_ai_minute_requests  -> requests_total
d_ai_hourly_requests  -> requests_total
d_ai_daily_tokens     -> tokens_total
d_ai_daily_requests   -> requests_total
```

When a token limit is created or edited in D-AI, D-AI syncs the relevant OpenMeter customer entitlement using current customer entitlement APIs. Metered entitlements use the non-deprecated `issue` payload, and static entitlements store the limit in their entitlement config. A limit value of `0` deletes that entitlement for the token/customer, which makes the limit unlimited again.

`totalTokens`, `tokensPerDay`, and `requestsPerDay` use metered entitlements. `requestsPerMinute` and `requestsPerHour` use static customer entitlements to store the limit value because the local OpenMeter image does not support sub-day metered entitlement periods; D-AI still queries the OpenMeter request meter for rolling minute/hour usage before enforcing those static entitlement values.

## Quota Checks

When checking token quotas, D-AI uses OpenMeter customer entitlements for quota limits:

- `totalTokens` is checked against the `d_ai_token_quota` customer entitlement.
- `requestsPerMinute` is checked against the `d_ai_minute_requests` customer entitlement.
- `requestsPerHour` is checked against the `d_ai_hourly_requests` customer entitlement.
- `tokensPerDay` is checked against the `d_ai_daily_tokens` customer entitlement.
- `requestsPerDay` is checked against the `d_ai_daily_requests` customer entitlement.

Quota checks use OpenMeter entitlement values and meter totals. D-AI token state does not store usage logs, quota counters, or desired quota limit values. Development uses the same ownership rule as production: OpenMeter customer entitlements are the quota source of truth.

With `OPENMETER_FAIL_CLOSED=true`, quota checks fail when OpenMeter cannot be queried. Keep this enabled in local development too so the stack behaves like production from the beginning.

## Verify Usage

After using a D-AI token, query OpenMeter directly:

```bash
curl 'http://localhost:48888/api/v1/meters/tokens_total/query?subject=dai_token_<TOKEN_ID>'
curl 'http://localhost:48888/api/v1/meters/requests_total/query?subject=dai_token_<TOKEN_ID>&windowSize=DAY&groupBy=status&groupBy=http_status'
```

Verify the entitlement value:

```bash
curl 'http://localhost:48888/api/v2/customers/dai_token_<TOKEN_ID>/entitlements/d_ai_token_quota/value'
```

For OpenMeter Cloud, include:

```bash
-H 'Authorization: Bearer <OPENMETER_API_TOKEN>'
```

## Production Direction

For production, keep D-AI as a real backend service with a database for token records and token metadata. Use OpenMeter customer entitlements for durable quota limits, entitlement values, metering, request analytics, billing, and customer-level usage reporting.

Recommended storage split:

- D-AI database, usually Postgres or MySQL: token records, hashed token secrets, token status, OpenMeter customer/subject mapping, and a metering outbox for retrying failed OpenMeter event delivery.
- OpenMeter: customer entitlements, quota values, usage totals, request totals, failure metrics, and billing/entitlement reporting.
- ClickHouse or another audit/log store: detailed request logs for debugging or compliance, kept outside the token metadata table.

If Casdoor pricing is used, treat it as plan ownership and coarse feature access. Treat OpenMeter entitlements as the runtime source for metered limits, such as monthly AI tokens, daily requests, prepaid usage balance, and model access checks.

Do not rely on `d-ai/.d-ai-state/tokens.json` for production token storage or metrics.
