# Logging Storage Options

This document compares storage options for D-AI request and audit logging.

## Architecture Position

D-AI should stay focused on token management:

- Create, update, activate, deactivate, and delete D-AI API tokens.
- Store token metadata and hashed token secrets.
- Store token limit configuration.
- Deterministically route token plus history key to a Casibase chat history.
- Emit metering events to OpenMeter.

OpenMeter should remain the source for quota counters, usage totals, request totals, success rate, failed request counts, and billing or entitlement reporting.

Detailed request logs are a separate concern. They should not live in `d-ai/.d-ai-state/tokens.json`, and they should not be stored inside the token metadata table.

## Local Implementation

The local stack uses this path:

```text
D-AI Vite middleware
  -> d-ai/.d-ai-state/logs/request-audit.jsonl
  -> d-ai-otel-collector
  -> d-ai-clickhouse
```

The JSONL file is a local log handoff file for OpenTelemetry Collector. It is not the source of truth and should not be queried as product state.

Start the local logging stack:

```bash
cd /Users/nedya.prakasa/Projects/casibase
docker compose up -d d-ai-clickhouse d-ai-otel-collector
```

The local ClickHouse HTTP endpoint is:

```text
http://localhost:18123
```

Query recent audit logs:

```bash
curl -u default:default 'http://localhost:18123/?database=d_ai_logs' \
  --data-binary "SELECT Timestamp, LogAttributes['token_id'], LogAttributes['status'], LogAttributes['http_status'], LogAttributes['failure_stage'] FROM otel_logs ORDER BY Timestamp DESC LIMIT 20"
```

The OpenTelemetry Collector config is:

```text
conf/d-ai-otel-collector/config.yaml
```

## Recommendation

For D-AI, use **ClickHouse as the default logging store** for structured request/audit logs.

D-AI request logs are mostly append-only, time-based, and structured:

- Token ID.
- Account ID.
- Request ID.
- Source, such as browser chat or OpenAI-compatible API.
- Model provider.
- History key.
- HTTP status.
- Failure stage.
- Token counts.
- Latency.
- Timestamp.

Those query patterns fit ClickHouse well: analytics by time range, token, status code, model, account, and failure reason.

Use **Elasticsearch** instead when the main requirement is full-text search over unstructured logs, stack traces, arbitrary error text, and a mature Kibana investigation workflow.

Do not start with SigNoz or Uptrace for this local D-AI layer. They are good open-source observability platforms, but they overlap with needs that are already split here: OpenMeter owns product metering, and ClickHouse owns structured audit logs. Add SigNoz or Uptrace later if the team wants a hosted UI for traces, application logs, service maps, alerts, and incident workflows across more than D-AI.

## Best Fit

| Need | Best store |
| --- | --- |
| Token quota checks | OpenMeter |
| Token usage dashboard | OpenMeter |
| Billing or entitlement reporting | OpenMeter |
| Token metadata and limits | D-AI database |
| OpenMeter retry buffer | D-AI `d_ai_metering_outbox` table |
| Structured request audit logs | ClickHouse |
| Full-text troubleshooting over raw logs | Elasticsearch |
| Cheap immutable long-term archive | S3 or object storage, optionally Parquet |

## ClickHouse

ClickHouse is a column-oriented analytics database. It is a strong fit when logs are structured events and most reads are analytical queries.

### Pros

- Efficient for high-volume append-only event logs.
- Strong for time-series analytics and group-by queries.
- SQL-native, which is useful for product analytics and audit reports.
- Good compression and lower storage cost for wide structured events.
- Works well for dashboards such as requests by token, failed requests by status code, latency percentiles, and usage by model.
- Supports lifecycle management patterns such as TTL for retention.
- Fits OpenTelemetry-based pipelines and ClickHouse-backed observability stacks.

### Cons

- Full-text search is not the primary strength compared with Elasticsearch.
- Requires thoughtful schema, partition key, order key, and retention design.
- Investigation UI depends on the chosen frontend, such as Grafana, HyperDX, ClickStack, or a custom admin page.
- Less natural for highly unstructured application logs where every event has a different shape.
- Updates and deletes are not the normal path; design logs as immutable append-only events.

### Recommended D-AI ClickHouse Table

```sql
CREATE TABLE d_ai_request_logs
(
  timestamp DateTime64(3),
  request_id String,
  account_owner LowCardinality(String),
  account_name String,
  token_id String,
  source LowCardinality(String),
  endpoint LowCardinality(String),
  method LowCardinality(String),
  status LowCardinality(String),
  http_status UInt16,
  error_type LowCardinality(String),
  failure_stage LowCardinality(String),
  model_provider LowCardinality(String),
  history_key_hash String,
  chat_name String,
  prompt_tokens UInt32,
  completion_tokens UInt32,
  total_tokens UInt32,
  latency_ms UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (account_owner, account_name, token_id, timestamp, http_status)
TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE;
```

Keep this table structured. Do not store raw bearer tokens, prompt bodies, uploaded file contents, or full model responses by default.

## Elasticsearch

Elasticsearch is a search engine and document store commonly used for log search and operational investigations.

### Pros

- Excellent full-text search over messages, stack traces, and free-form error text.
- Kibana gives strong out-of-the-box log exploration, filtering, dashboards, and incident investigation workflows.
- Data streams and ILM are designed for append-only time-series logs.
- Mature ingestion ecosystem through Elastic Agent, Beats, Logstash, OpenTelemetry, and ingest pipelines.
- Good choice when engineers frequently search by arbitrary words from raw logs.

### Cons

- Usually more expensive for long-retention high-volume structured analytics.
- Requires shard, mapping, index template, rollover, and lifecycle management discipline.
- High-cardinality aggregations can become costly compared with ClickHouse.
- Easy to accidentally duplicate OpenMeter by treating Elasticsearch as the metrics source.
- Mapping drift and unbounded fields can cause operational pain if logs are not normalized.

### Recommended D-AI Elasticsearch Index

Use a logs data stream:

```text
logs-d-ai-request-default
```

Recommended field style:

```json
{
  "@timestamp": "2026-05-08T12:00:00.000Z",
  "event.dataset": "d-ai.request",
  "event.action": "chat.completion",
  "event.outcome": "success",
  "http.response.status_code": 200,
  "d_ai.account.owner": "ifm",
  "d_ai.account.name": "user",
  "d_ai.token.id": "tok_...",
  "d_ai.history.key_hash": "sha256:...",
  "d_ai.model.provider": "provider-openai-v1",
  "d_ai.usage.prompt_tokens": 12,
  "d_ai.usage.completion_tokens": 40,
  "d_ai.usage.total_tokens": 52,
  "event.duration": 250000000
}
```

Avoid storing raw prompts and model outputs unless there is an explicit product, compliance, and privacy decision.

## Hybrid Option

A practical production split is:

- OpenMeter for metering, quota, success/failure totals, and billing.
- ClickHouse for durable structured request/audit logs.
- Elasticsearch for short-retention raw application logs and incident search, if the team needs Kibana-style troubleshooting.
- S3 or another object store for low-cost immutable archive.

This avoids turning D-AI into a logging system and avoids using one store for every workload.

## D-AI Logging Contract

D-AI should emit one request audit event per API request:

- Emit on success.
- Emit on failure.
- Include a stable `request_id`.
- Include token ID, not token secret.
- Include a hash of the history key if the raw value may contain user/project context.
- Include token counts and latency.
- Include error type and failure stage.
- Do not include raw prompts, uploaded files, bearer tokens, session cookies, or full model responses by default.

The D-AI database may keep a small `d_ai_metering_outbox` table for delivery retries. That outbox is not the analytical log store. It should be drained into OpenMeter and the logging pipeline, then expired.

## Final Choice

For this project, choose **ClickHouse first**.

The D-AI token page needs structured monitoring more than free-text search:

- Usage over time.
- Failed requests by status code.
- Success rate.
- Requests by token.
- Latency by token/model.
- Quota and limit visibility.

Those are analytical queries. ClickHouse is the better fit for the optional request audit store. Add Elasticsearch later only if the team needs rich full-text troubleshooting across raw service logs.

## References

- ClickHouse observability use case: https://clickhouse.com/use-cases/observability
- ClickHouse and OpenTelemetry: https://clickhouse.com/blog/clickhouse-and-open-telemtry
- Elastic log monitoring: https://www.elastic.co/docs/solutions/observability/logs
- Elasticsearch data streams: https://www.elastic.co/docs/manage-data/data-store/data-streams
- Elasticsearch index lifecycle management: https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management
- SigNoz overview: https://signoz.io/docs/userguide/overview/
- Uptrace getting started: https://uptrace.dev/get
