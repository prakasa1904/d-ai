function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeDays(days) {
  const value = Number(days);
  return [1, 7, 30, 90].includes(value) ? value : 7;
}

function rangeStartForDays(days) {
  const date = new Date();
  if (days === 1) {
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }

  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (days - 1));
  return date.toISOString();
}

function identifier(value, fallback) {
  const text = String(value || fallback || "").trim();
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text) ? text : fallback;
}

function sqlString(value) {
  return `'${String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function sqlStringList(values) {
  return values.map(sqlString).join(", ");
}

function emptySummary() {
  return {
    total: 0,
    success: 0,
    failed: 0,
    totalTokens: 0,
    promptTokens: 0,
    responseTokens: 0,
    lastSeenAt: "",
    lastFailureAt: "",
    lastFailureReason: "",
  };
}

function emptyLogs({enabled, periodDays, selectedTokenId, source = "clickhouse"}) {
  return {
    enabled,
    source,
    periodDays,
    selectedTokenId,
    generatedAt: new Date().toISOString(),
    totals: emptySummary(),
    byToken: {},
    events: [],
  };
}

function normalizeRow(row = {}) {
  const status = String(row.status || "").toLowerCase() === "failed" ? "failed" : "success";

  return {
    id: row.id || "",
    createdAt: row.createdAt || "",
    tokenId: row.tokenId || "",
    tokenName: row.tokenName || "",
    status,
    source: row.source || "",
    endpoint: row.endpoint || "",
    method: row.method || "",
    historyKeyHash: row.historyKeyHash || "",
    httpStatus: Number(row.httpStatus || (status === "success" ? 200 : 0)),
    errorType: row.errorType || "",
    errorMessage: row.errorMessage || "",
    failureStage: row.failureStage || "",
    promptTokens: Number(row.promptTokens || 0),
    responseTokens: Number(row.responseTokens || 0),
    totalTokens: Number(row.totalTokens || 0),
    latencyMs: Number(row.latencyMs || 0),
    chatName: row.chatName || "",
    modelProvider: row.modelProvider || "",
  };
}

function addSummary(summary, event) {
  summary.total += 1;
  if (event.status === "success") {
    summary.success += 1;
  } else {
    summary.failed += 1;
    if (!summary.lastFailureAt || event.createdAt > summary.lastFailureAt) {
      summary.lastFailureAt = event.createdAt;
      summary.lastFailureReason = event.errorMessage || event.errorType || event.failureStage || "Failed";
    }
  }
  summary.promptTokens += Number(event.promptTokens || 0);
  summary.responseTokens += Number(event.responseTokens || 0);
  summary.totalTokens += Number(event.totalTokens || 0);
  if (!summary.lastSeenAt || event.createdAt > summary.lastSeenAt) {
    summary.lastSeenAt = event.createdAt;
  }
}

function buildLogSummary(events, tokens) {
  const byToken = {};
  const totals = emptySummary();

  tokens.forEach((token) => {
    byToken[token.id] = emptySummary();
  });

  events.forEach((event) => {
    byToken[event.tokenId] = byToken[event.tokenId] || emptySummary();
    addSummary(byToken[event.tokenId], event);
    addSummary(totals, event);
  });

  return {byToken, totals};
}

export function createClickHouseLogClient(options = {}) {
  const config = {
    enabled: normalizeBoolean(options.enabled, true),
    baseUrl: String(options.baseUrl || "http://localhost:18123").replace(/\/+$/, ""),
    username: options.username || "default",
    password: options.password || "default",
    database: identifier(options.database, "d_ai_logs"),
    table: identifier(options.table, "otel_logs"),
  };

  async function query(sql) {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    const response = await fetch(`${config.baseUrl}/?database=${encodeURIComponent(config.database)}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: sql,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(text.trim() || `ClickHouse query failed with ${response.status}`);
    }

    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function getRequestLogs({accountState, periodDays = 7, selectedTokenId = "all", limit = 500}) {
    const normalizedDays = normalizeDays(periodDays);
    const account = accountState?.account || {};
    const tokens = Array.isArray(accountState?.tokens) ? accountState.tokens : [];
    const selectedTokens = selectedTokenId && selectedTokenId !== "all"
      ? tokens.filter((token) => token.id === selectedTokenId)
      : tokens;
    const requestedLimit = Math.floor(Number(limit || 500));
    const normalizedLimit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1), 1000);
    const result = emptyLogs({
      enabled: config.enabled,
      periodDays: normalizedDays,
      selectedTokenId,
    });

    tokens.forEach((token) => {
      result.byToken[token.id] = emptySummary();
    });

    if (!config.enabled || !selectedTokens.length) {
      return result;
    }

    const tokenIds = selectedTokens.map((token) => token.id);
    const from = rangeStartForDays(normalizedDays);
    const to = new Date().toISOString();
    const rows = await query(`
SELECT
  formatDateTime(Timestamp, '%Y-%m-%dT%H:%i:%SZ') AS createdAt,
  LogAttributes['request_id'] AS id,
  LogAttributes['token_id'] AS tokenId,
  LogAttributes['token_name'] AS tokenName,
  LogAttributes['status'] AS status,
  LogAttributes['source'] AS source,
  LogAttributes['endpoint'] AS endpoint,
  LogAttributes['method'] AS method,
  LogAttributes['history_key_hash'] AS historyKeyHash,
  LogAttributes['http_status'] AS httpStatus,
  LogAttributes['error_type'] AS errorType,
  LogAttributes['error_message'] AS errorMessage,
  LogAttributes['failure_stage'] AS failureStage,
  LogAttributes['prompt_tokens'] AS promptTokens,
  LogAttributes['completion_tokens'] AS responseTokens,
  LogAttributes['total_tokens'] AS totalTokens,
  LogAttributes['latency_ms'] AS latencyMs,
  LogAttributes['chat_name'] AS chatName,
  LogAttributes['model_provider'] AS modelProvider
FROM ${config.table}
WHERE Timestamp >= parseDateTime64BestEffort(${sqlString(from)})
  AND Timestamp <= parseDateTime64BestEffort(${sqlString(to)})
  AND LogAttributes['account_owner'] = ${sqlString(account.owner)}
  AND LogAttributes['account_name'] = ${sqlString(account.name)}
  AND LogAttributes['token_id'] IN (${sqlStringList(tokenIds)})
ORDER BY Timestamp DESC
LIMIT ${normalizedLimit}
FORMAT JSONEachRow
`);
    const events = rows.map(normalizeRow);
    const {byToken, totals} = buildLogSummary(events, tokens);

    return {
      ...result,
      totals,
      byToken: {
        ...result.byToken,
        ...byToken,
      },
      events,
    };
  }

  return {
    enabled: config.enabled,
    getRequestLogs,
  };
}
