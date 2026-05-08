import {normalizeTokenLimits} from "../src/tokens.js";

function now() {
  return new Date();
}

function startOfToday(date = now()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function rangeStartForDays(days, date = now()) {
  const today = startOfToday(date);
  const result = new Date(today);
  result.setDate(today.getDate() - Math.max(0, Number(days || 1) - 1));
  return result;
}

function oneMinuteAgo(date = now()) {
  return new Date(new Date(date).getTime() - 60 * 1000);
}

function oneHourAgo(date = now()) {
  return new Date(new Date(date).getTime() - 60 * 60 * 1000);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function sanitizeSubject(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 180);
}

function accountSubject(account = {}) {
  return sanitizeSubject(`dai_account_${account.owner || "unknown"}_${account.name || "unknown"}`);
}

function tokenSubject(token = {}) {
  return sanitizeSubject(`dai_token_${token.id || "unknown"}`);
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localHourKey(date) {
  return [
    localDateKey(date),
    String(date.getHours()).padStart(2, "0"),
  ].join("T");
}

function bucketKeyFor(date, periodDays) {
  return Number(periodDays) === 1 ? localHourKey(date) : localDateKey(date);
}

function buildMetricBuckets(periodDays) {
  if (Number(periodDays) === 1) {
    const start = startOfToday();
    return Array.from({length: 24}, (_, hour) => {
      const date = new Date(start);
      date.setHours(hour, 0, 0, 0);
      return {
        key: localHourKey(date),
        label: new Intl.DateTimeFormat(undefined, {hour: "2-digit"}).format(date),
        requests: 0,
        promptTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
        price: 0,
        success: 0,
        failed: 0,
        total: 0,
        successRate: null,
      };
    });
  }

  const today = startOfToday();
  return Array.from({length: Number(periodDays || 7)}, (_, index) => {
    const offset = Number(periodDays || 7) - 1 - index;
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    return {
      key: localDateKey(date),
      label: new Intl.DateTimeFormat(undefined, Number(periodDays) <= 7 ? {weekday: "short"} : {month: "short", day: "numeric"}).format(date),
      requests: 0,
      promptTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      price: 0,
      success: 0,
      failed: 0,
      total: 0,
      successRate: null,
    };
  });
}

function metricRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function sumRows(rows) {
  return rows.reduce((total, row) => total + Number(row?.value || 0), 0);
}

function usageErrorMessage(payload, response) {
  return payload?.detail
    || payload?.title
    || payload?.message
    || payload?.error?.message
    || `${response.status} ${response.statusText}`;
}

async function readJsonOrText(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function publicConfig(config) {
  return {
    enabled: config.enabled,
    baseUrl: config.enabled ? config.baseUrl : "",
    meterSlug: config.meterSlug,
    requestMeterSlug: config.requestMeterSlug,
    promptMeterSlug: config.promptMeterSlug,
    completionMeterSlug: config.completionMeterSlug,
    costMeterSlug: config.costMeterSlug,
    eventType: config.eventType,
    subjectMode: config.subjectMode,
    failClosed: config.failClosed,
    entitlementsEnabled: config.entitlementsEnabled,
    totalTokensFeatureKey: config.totalTokensFeatureKey,
    requestsPerMinuteFeatureKey: config.requestsPerMinuteFeatureKey,
    requestsPerHourFeatureKey: config.requestsPerHourFeatureKey,
    tokensPerDayFeatureKey: config.tokensPerDayFeatureKey,
    requestsPerDayFeatureKey: config.requestsPerDayFeatureKey,
    totalTokensEntitlementPeriod: config.totalTokensEntitlementPeriod,
  };
}

function tokenIdFromRow(row) {
  return row?.groupBy?.token_id || "";
}

function normalizeStatus(value, httpStatus) {
  const status = String(value || "").toLowerCase();
  if (status === "success" || status === "failed") {
    return status;
  }

  return Number(httpStatus || 0) >= 400 ? "failed" : "success";
}

function emptyTokenMetric() {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    successRate: null,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    price: 0,
    lastUsedAt: "",
    lastFailureAt: "",
    lastFailureReason: "",
  };
}

function emptyMetrics({periodDays, selectedTokenId = "all", enabled = false, source = "openmeter"}) {
  return {
    enabled,
    source,
    selectedTokenId,
    periodDays,
    generatedAt: new Date().toISOString(),
    totals: {
      requests: 0,
      success: 0,
      failed: 0,
      successRate: null,
      promptTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      price: 0,
    },
    selectedTotals: {
      requests: 0,
      success: 0,
      failed: 0,
      successRate: null,
      promptTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      price: 0,
    },
    byToken: {},
    requestByToken: {},
    limitByToken: {},
    usageSeries: buildMetricBuckets(periodDays),
    requestSeries: buildMetricBuckets(periodDays),
    failedStatusChart: {
      lines: [],
      series: buildMetricBuckets(periodDays),
    },
    failureBreakdown: [],
  };
}

function addTokenValue(byToken, tokenId, field, value) {
  if (!tokenId) {
    return;
  }

  byToken[tokenId] = byToken[tokenId] || emptyTokenMetric();
  byToken[tokenId][field] += Number(value || 0);
}

function addSeriesValue(seriesByKey, row, periodDays, selectedTokenIds, field) {
  const tokenId = tokenIdFromRow(row);
  if (selectedTokenIds.size && !selectedTokenIds.has(tokenId)) {
    return;
  }

  const date = new Date(row?.windowStart || "");
  if (Number.isNaN(date.getTime())) {
    return;
  }

  const bucket = seriesByKey.get(bucketKeyFor(date, periodDays));
  if (bucket) {
    bucket[field] += Number(row?.value || 0);
  }
}

function formatLimitCheck({key, label, used, projected, limit, source = "openmeter"}) {
  const exceeded = limit > 0 && projected > limit;

  return {
    key,
    label,
    used,
    projected,
    limit,
    source,
    exceeded,
    missing: false,
    blocked: exceeded,
    remaining: limit > 0 ? Math.max(0, limit - used) : Infinity,
  };
}

function entitlementConfigLimit(value) {
  try {
    const parsed = JSON.parse(value?.config || "{}");
    return Math.max(0, Math.floor(Number(parsed.limit || 0)));
  } catch {
    return 0;
  }
}

function formatEntitlementLimitCheck({definition, value, used: usedOverride, pending = 0, fallbackLimit = 0, customerKey = ""}) {
  const used = Number(value?.usage ?? usedOverride ?? 0);
  const limit = Number(value?.totalAvailableGrantAmount || entitlementConfigLimit(value) || fallbackLimit || 0);
  const projected = used + Number(pending || 0);
  const balance = Number(value?.balance ?? Math.max(0, limit - used));
  const blocked = limit > 0 && (value?.hasAccess === false || projected > limit || balance < Number(pending || 0));

  return {
    key: definition.key,
    label: definition.label,
    used,
    projected,
    limit,
    source: "openmeter-customer-entitlement",
    exceeded: blocked,
    missing: false,
    blocked,
    remaining: Math.max(0, Math.min(balance, limit > 0 ? limit - used : balance)),
    customerKey,
    featureKey: definition.featureKey,
    hasAccess: value?.hasAccess === undefined ? !blocked : value.hasAccess !== false,
  };
}

function entitlementPeriod(value, fallback) {
  const period = String(value || fallback || "MONTH").trim().toUpperCase();
  return ["DAY", "WEEK", "MONTH", "YEAR"].includes(period) || /^P/i.test(period) ? period : fallback;
}

function sameNumber(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;
}

export function createOpenMeterClient(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl);
  const config = {
    enabled: normalizeBoolean(options.enabled, false) && Boolean(baseUrl),
    baseUrl,
    apiToken: String(options.apiToken || ""),
    meterSlug: String(options.meterSlug || "tokens_total"),
    requestMeterSlug: String(options.requestMeterSlug || "requests_total"),
    promptMeterSlug: String(options.promptMeterSlug || "prompt_tokens_total"),
    completionMeterSlug: String(options.completionMeterSlug || "completion_tokens_total"),
    costMeterSlug: String(options.costMeterSlug || "cost_total"),
    eventType: String(options.eventType || "prompt"),
    eventSource: String(options.eventSource || "d-ai"),
    subjectMode: ["account", "user"].includes(String(options.subjectMode || "").toLowerCase())
      ? "account"
      : "token",
    failClosed: normalizeBoolean(options.failClosed, false),
    entitlementsEnabled: normalizeBoolean(options.entitlementsEnabled, true),
    totalTokensFeatureKey: String(options.totalTokensFeatureKey || "d_ai_token_quota"),
    requestsPerMinuteFeatureKey: String(options.requestsPerMinuteFeatureKey || "d_ai_minute_requests"),
    requestsPerHourFeatureKey: String(options.requestsPerHourFeatureKey || "d_ai_hourly_requests"),
    tokensPerDayFeatureKey: String(options.tokensPerDayFeatureKey || "d_ai_daily_tokens"),
    requestsPerDayFeatureKey: String(options.requestsPerDayFeatureKey || "d_ai_daily_requests"),
    totalTokensEntitlementPeriod: entitlementPeriod(options.totalTokensEntitlementPeriod, "P100Y"),
  };
  const ensuredFeatures = new Set();

  const entitlementDefinitions = [
    {
      key: "totalTokens",
      label: "Token entitlement quota",
      featureKey: config.totalTokensFeatureKey,
      featureName: "D-AI Token Entitlement Quota",
      entitlementType: "metered",
      meterSlug: config.meterSlug,
      period: config.totalTokensEntitlementPeriod,
      measureUsageFrom: "1970-01-01T00:00:00.000Z",
      preserveOverageAtReset: true,
      pending: (pendingTokens) => Number(pendingTokens || 0),
    },
    {
      key: "requestsPerMinute",
      label: "Requests / minute entitlement",
      featureKey: config.requestsPerMinuteFeatureKey,
      featureName: "D-AI Minute Request Entitlement",
      entitlementType: "static",
      meterSlug: config.requestMeterSlug,
      period: "PT1M",
      measureUsageFrom: "CURRENT_PERIOD_START",
      preserveOverageAtReset: false,
      pending: () => 1,
    },
    {
      key: "requestsPerHour",
      label: "Requests / hour entitlement",
      featureKey: config.requestsPerHourFeatureKey,
      featureName: "D-AI Hourly Request Entitlement",
      entitlementType: "static",
      meterSlug: config.requestMeterSlug,
      period: "PT1H",
      measureUsageFrom: "CURRENT_PERIOD_START",
      preserveOverageAtReset: false,
      pending: () => 1,
    },
    {
      key: "requestsPerDay",
      label: "Requests / day entitlement",
      featureKey: config.requestsPerDayFeatureKey,
      featureName: "D-AI Daily Request Entitlement",
      entitlementType: "metered",
      meterSlug: config.requestMeterSlug,
      period: "DAY",
      measureUsageFrom: "CURRENT_PERIOD_START",
      preserveOverageAtReset: false,
      pending: () => 1,
    },
    {
      key: "tokensPerDay",
      label: "Tokens / day entitlement",
      featureKey: config.tokensPerDayFeatureKey,
      featureName: "D-AI Daily Token Entitlement",
      entitlementType: "metered",
      meterSlug: config.meterSlug,
      period: "DAY",
      measureUsageFrom: "CURRENT_PERIOD_START",
      preserveOverageAtReset: false,
      pending: (pendingTokens) => Number(pendingTokens || 0),
    },
  ];

  async function request(pathname, requestOptions = {}) {
    if (!config.enabled) {
      throw new Error("OpenMeter is not enabled");
    }

    const headers = {
      Accept: "application/json",
      ...(requestOptions.headers || {}),
    };

    if (config.apiToken) {
      headers.Authorization = `Bearer ${config.apiToken}`;
    }

    const response = await fetch(`${config.baseUrl}${pathname}`, {
      ...requestOptions,
      headers,
    });
    const payload = await readJsonOrText(response);

    if (!response.ok) {
      const error = new Error(usageErrorMessage(payload, response));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function subjectFor({token, account}) {
    if (config.subjectMode === "account") {
      return accountSubject(account || token?.account);
    }

    return tokenSubject(token);
  }

  function entitlementCustomerKey({token, account}) {
    return subjectFor({token, account});
  }

  function entitlementCustomerName({token, account}) {
    if (config.subjectMode === "account") {
      return `D-AI Account ${account?.owner || token?.account?.owner || "unknown"}/${account?.name || token?.account?.name || "unknown"}`;
    }

    return `D-AI Token ${token?.name || token?.id || "unknown"}`;
  }

  function entitlementPayload(definition, limit, token) {
    if (definition.entitlementType === "static") {
      return {
        type: "static",
        featureKey: definition.featureKey,
        metadata: {
          "d_ai.limit_key": definition.key,
          "d_ai.token_id": token?.id || "",
        },
        config: JSON.stringify({
          limit: Number(limit || 0),
          window: definition.period,
        }),
      };
    }

    return {
      type: "metered",
      featureKey: definition.featureKey,
      metadata: {
        "d_ai.limit_key": definition.key,
        "d_ai.token_id": token?.id || "",
      },
      isSoftLimit: false,
      usagePeriod: {
        interval: definition.period,
        anchor: "1970-01-01T00:00:00.000Z",
      },
      measureUsageFrom: definition.measureUsageFrom,
      preserveOverageAtReset: definition.preserveOverageAtReset,
      issue: {
        amount: Number(limit || 0),
        priority: 1,
      },
    };
  }

  async function ensureFeature(definition) {
    if (!definition?.featureKey || ensuredFeatures.has(definition.featureKey)) {
      return;
    }

    try {
      await request(`/api/v1/features/${encodeURIComponent(definition.featureKey)}`);
      ensuredFeatures.add(definition.featureKey);
      return;
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    try {
      await request("/api/v1/features", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: definition.featureKey,
          name: definition.featureName,
          meterSlug: definition.meterSlug,
        }),
      });
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
    }

    ensuredFeatures.add(definition.featureKey);
  }

  async function ensureEntitlementCustomer({token, account}) {
    const subject = subjectFor({token, account});
    const customerKey = entitlementCustomerKey({token, account});
    const customerName = entitlementCustomerName({token, account});

    try {
      const existing = await request(`/api/v1/customers/${encodeURIComponent(customerKey)}`);
      const subjectKeys = new Set(existing?.usageAttribution?.subjectKeys || []);
      if (!subjectKeys.has(subject)) {
        subjectKeys.add(subject);
        await request(`/api/v1/customers/${encodeURIComponent(customerKey)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: existing?.name || customerName,
            description: existing?.description || "D-AI OpenMeter entitlement customer",
            metadata: existing?.metadata || {},
            key: existing?.key || customerKey,
            usageAttribution: {
              subjectKeys: [...subjectKeys],
            },
          }),
        });
      }

      return {customerKey, subject};
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    await request("/api/v1/customers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: customerKey,
        name: customerName,
        description: "D-AI OpenMeter entitlement customer",
        metadata: {
          "d_ai.account_owner": account?.owner || token?.account?.owner || "",
          "d_ai.account_name": account?.name || token?.account?.name || "",
          "d_ai.token_id": token?.id || "",
        },
        usageAttribution: {
          subjectKeys: [subject],
        },
      }),
    });

    return {customerKey, subject};
  }

  async function queryMeterRows(meterSlug, {subject, from, to, windowSize, groupBy = []} = {}) {
    const params = new URLSearchParams();

    if (subject) {
      params.append("subject", subject);
    }
    if (from) {
      params.set("from", new Date(from).toISOString());
    }
    if (to) {
      params.set("to", new Date(to).toISOString());
    }
    if (windowSize) {
      params.set("windowSize", windowSize);
    }
    [...new Set(groupBy.filter(Boolean))].forEach((field) => params.append("groupBy", field));

    const query = params.toString();
    const payload = await request(`/api/v1/meters/${encodeURIComponent(meterSlug)}/query${query ? `?${query}` : ""}`);
    return metricRows(payload);
  }

  async function queryRowsForTokens(meterSlug, {tokens, account, from, to, windowSize, groupBy = []}) {
    if (!tokens.length) {
      return [];
    }

    const tokenIds = new Set(tokens.map((token) => token.id));
    const groupedFields = [...new Set(["token_id", ...groupBy])];

    if (config.subjectMode === "account") {
      const rows = await queryMeterRows(meterSlug, {
        subject: accountSubject(account),
        from,
        to,
        windowSize,
        groupBy: groupedFields,
      });
      return rows.filter((row) => tokenIds.has(tokenIdFromRow(row)));
    }

    const nestedRows = await Promise.all(tokens.map(async (token) => {
      const rows = await queryMeterRows(meterSlug, {
        subject: subjectFor({token, account}),
        from,
        to,
        windowSize,
        groupBy: groupedFields,
      });

      return rows.map((row) => ({
        ...row,
        groupBy: {
          token_id: token.id,
          ...(row.groupBy || {}),
        },
      }));
    }));

    return nestedRows.flat();
  }

  async function queryUsage({subject, from, to}) {
    return sumRows(await queryMeterRows(config.meterSlug, {subject, from, to}));
  }

  async function queryRequestCount({subject, from, to}) {
    return sumRows(await queryMeterRows(config.requestMeterSlug, {subject, from, to}));
  }

  async function emitEvent({token, account, id, time, data}) {
    const event = {
      id: `d-ai-${id || Date.now()}`,
      source: config.eventSource,
      specversion: "1.0",
      type: config.eventType,
      subject: subjectFor({token, account}),
      time: time || new Date().toISOString(),
      data,
    };

    await request("/api/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/cloudevents-batch+json",
      },
      body: JSON.stringify([event]),
    });

    return {status: "ok", subject: event.subject};
  }

  async function recordUsage({token, account, usageRecord, source = "api"}) {
    if (!config.enabled) {
      return {status: "skipped", reason: "openmeter_disabled"};
    }

    const totalTokens = Number(usageRecord?.totalTokens || 0);
    if (totalTokens <= 0) {
      return {status: "skipped", reason: "no_token_usage"};
    }

    return emitEvent({
      token,
      account,
      id: usageRecord.id,
      time: usageRecord.createdAt || new Date().toISOString(),
      data: {
        request_count: 1,
        tokens: totalTokens,
        prompt_tokens: Number(usageRecord.promptTokens || 0),
        completion_tokens: Number(usageRecord.responseTokens || 0),
        price: Number(usageRecord.price || 0),
        model: usageRecord.modelProvider || "d-ai-casibase",
        type: "total",
        source,
        status: "success",
        http_status: 200,
        error_type: "",
        error_message: "",
        failure_stage: "",
        latency_ms: Number(usageRecord.latencyMs || 0),
        token_id: token?.id || usageRecord.tokenId || "",
        token_name: token?.name || "",
        account_owner: account?.owner || token?.account?.owner || "",
        account_name: account?.name || token?.account?.name || "",
        history_key: usageRecord.historyKey || "",
        chat_name: usageRecord.chatName || "",
        chat_title: usageRecord.chatTitle || "",
        usage_id: usageRecord.id || "",
      },
    });
  }

  async function recordRequestFailure({token, account, event}) {
    if (!config.enabled || !token) {
      return {status: "skipped", reason: "openmeter_disabled_or_missing_token"};
    }

    return emitEvent({
      token,
      account,
      id: event.id,
      time: event.createdAt || new Date().toISOString(),
      data: {
        request_count: 1,
        tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        price: 0,
        model: event.modelProvider || "d-ai-casibase",
        type: "total",
        source: event.source || "api",
        status: "failed",
        http_status: event.httpStatus || 500,
        error_type: event.errorType || "server_error",
        error_message: event.errorMessage || "",
        failure_stage: event.failureStage || "",
        latency_ms: Number(event.latencyMs || 0),
        token_id: token.id || event.tokenId || "",
        token_name: token.name || "",
        account_owner: account?.owner || token?.account?.owner || "",
        account_name: account?.name || token?.account?.name || "",
        history_key: event.historyKey || "",
        chat_name: event.chatName || "",
        chat_title: event.chatTitle || "",
        usage_id: "",
      },
    });
  }

  async function getEntitlementValue({customerKey, featureKey}) {
    return request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(featureKey)}/value`);
  }

  async function getEntitlement({customerKey, featureKey}) {
    return request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(featureKey)}`);
  }

  function entitlementMatchesConfig(entitlement, definition, limit) {
    if (definition.entitlementType === "static") {
      return entitlement?.type === "static" && sameNumber(entitlementConfigLimit(entitlement), limit);
    }

    return sameNumber(entitlement?.issue?.amount, limit)
      && String(entitlement?.usagePeriod?.interval || "").toUpperCase() === String(definition.period).toUpperCase()
      && String(entitlement?.measureUsageFrom || "") === String(definition.measureUsageFrom)
      && Boolean(entitlement?.preserveOverageAtReset) === Boolean(definition.preserveOverageAtReset);
  }

  async function deleteEntitlement({customerKey, featureKey}) {
    try {
      await request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(featureKey)}`, {
        method: "DELETE",
      });
      return {featureKey, status: "deleted"};
    } catch (error) {
      if (error.status === 404) {
        return {featureKey, status: "not_found"};
      }

      throw error;
    }
  }

  async function upsertEntitlement({customerKey, definition, limit, token}) {
    await ensureFeature(definition);

    try {
      const entitlement = await getEntitlement({customerKey, featureKey: definition.featureKey});
      if (entitlementMatchesConfig(entitlement, definition, limit)) {
        const value = await getEntitlementValue({customerKey, featureKey: definition.featureKey});
        return {featureKey: definition.featureKey, status: "unchanged", value};
      }

      const overridden = await request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(definition.featureKey)}/override`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entitlementPayload(definition, limit, token)),
      });
      return {featureKey: definition.featureKey, status: "overridden", entitlement: overridden};
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    try {
      const entitlement = await request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entitlementPayload(definition, limit, token)),
      });
      return {featureKey: definition.featureKey, status: "created", entitlement};
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }

      const entitlement = await request(`/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(definition.featureKey)}/override`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entitlementPayload(definition, limit, token)),
      });
      return {featureKey: definition.featureKey, status: "overridden", entitlement};
    }
  }

  async function deleteTokenEntitlements({token, account}) {
    if (!config.enabled || !config.entitlementsEnabled || !token) {
      return {
        enabled: false,
        source: "openmeter-customer-entitlement",
      };
    }

    const customerKey = entitlementCustomerKey({token, account});
    const subject = subjectFor({token, account});
    const entries = await Promise.all(entitlementDefinitions.map((definition) => (
      deleteEntitlement({customerKey, featureKey: definition.featureKey})
    )));

    return {
      enabled: true,
      source: "openmeter-customer-entitlement",
      customerKey,
      subject,
      entries,
    };
  }

  async function syncTokenEntitlements({token, account, limits: requestedLimits, removeUnlimited = false}) {
    if (!config.enabled || !config.entitlementsEnabled || !token) {
      return {
        enabled: false,
        source: "openmeter-customer-entitlement",
      };
    }

    const limits = normalizeTokenLimits(requestedLimits);
    const hasEntitlementLimits = entitlementDefinitions.some((definition) => Number(limits[definition.key] || 0) > 0);
    if (!hasEntitlementLimits && !removeUnlimited) {
      return {
        enabled: true,
        source: "openmeter-customer-entitlement",
        entries: [],
      };
    }

    if (!hasEntitlementLimits && removeUnlimited) {
      return deleteTokenEntitlements({token, account});
    }

    const {customerKey, subject} = await ensureEntitlementCustomer({token, account});
    const entries = [];

    for (const definition of entitlementDefinitions) {
      const limit = Number(limits[definition.key] || 0);
      if (limit > 0) {
        entries.push(await upsertEntitlement({customerKey, definition, limit, token}));
      } else if (removeUnlimited) {
        entries.push(await deleteEntitlement({customerKey, featureKey: definition.featureKey}));
      }
    }

    return {
      enabled: true,
      source: "openmeter-customer-entitlement",
      customerKey,
      subject,
      entries,
    };
  }

  function entitlementUsageFrom(definition, at) {
    if (definition.key === "totalTokens") {
      return new Date(0);
    }
    if (definition.key === "requestsPerMinute") {
      return oneMinuteAgo(at);
    }
    if (definition.key === "requestsPerHour") {
      return oneHourAgo(at);
    }

    return startOfToday(at);
  }

  async function queryDefinitionUsage({definition, subject, at}) {
    return sumRows(await queryMeterRows(definition.meterSlug, {
      subject,
      from: entitlementUsageFrom(definition, at),
      to: new Date(at).toISOString(),
    }));
  }

  async function getDefinitionEntitlementCheck({definition, customerKey, subject, at = now(), pending = 0}) {
    try {
      const value = await getEntitlementValue({
        customerKey,
        featureKey: definition.featureKey,
      });
      const hasEntitlementValue = value && [
        "hasAccess",
        "balance",
        "usage",
        "overage",
        "totalAvailableGrantAmount",
      ].some((key) => value[key] !== undefined);

      if (!hasEntitlementValue) {
        return null;
      }
      const used = definition.entitlementType === "static"
        ? await queryDefinitionUsage({definition, subject, at})
        : undefined;

      return formatEntitlementLimitCheck({
        definition,
        value,
        used,
        pending,
        fallbackLimit: 0,
        customerKey,
      });
    } catch (error) {
      if (error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async function getConfiguredEntitlementChecks({token, account, pendingTokens = 0, at = now()}) {
    const customerKey = entitlementCustomerKey({token, account});
    const subject = subjectFor({token, account});
    const checks = await Promise.all(entitlementDefinitions.map((definition) => (
      getDefinitionEntitlementCheck({
        definition,
        customerKey,
        subject,
        at,
        pending: definition.pending(pendingTokens),
      })
    )));

    return {
      customerKey,
      checks: checks.filter(Boolean),
    };
  }

  async function checkTokenLimits({token, accountState, pendingTokens = 0, at = now()}) {
    if (!config.enabled) {
      return {enabled: false};
    }

    const account = accountState?.account || token?.account || {};
    const subject = subjectFor({token, account});
    const checks = [];

    try {
      let customerKey = "";
      if (config.entitlementsEnabled) {
        const entitlementStatus = await getConfiguredEntitlementChecks({token, account, pendingTokens, at});
        checks.push(...entitlementStatus.checks);
        customerKey = entitlementStatus.customerKey;
      }

      const blocked = checks.filter((check) => check.blocked);

      return {
        enabled: true,
        allowed: blocked.length === 0,
        reasons: blocked.map((check) => `${check.label} limit reached (${check.used}/${check.limit})`),
        checks,
        subject,
        customerKey,
        meterSlug: config.meterSlug,
      };
    } catch (error) {
      if (config.failClosed) {
        return {
          enabled: true,
          allowed: false,
          reasons: [`OpenMeter quota check failed: ${error.message}`],
          checks: [],
          subject,
          meterSlug: config.meterSlug,
          error: error.message,
        };
      }

      return {
        enabled: true,
        allowed: true,
        reasons: [],
        checks: [],
        subject,
        meterSlug: config.meterSlug,
        warning: error.message,
      };
    }
  }

  async function getLimitSnapshot({token, account, at = now()}) {
    const subject = subjectFor({token, account});
    const customerKey = entitlementCustomerKey({token, account});
    let entitlementChecksByKey = {};

    if (config.entitlementsEnabled) {
      const entitlementChecks = await Promise.all(entitlementDefinitions.map(async (definition) => [
        definition.key,
        await getDefinitionEntitlementCheck({definition, customerKey, subject, at}),
      ]));
      entitlementChecksByKey = Object.fromEntries(entitlementChecks.filter(([, check]) => Boolean(check)));
    }

    const checks = await Promise.all(entitlementDefinitions.map(async (definition) => {
      if (entitlementChecksByKey[definition.key]) {
        return entitlementChecksByKey[definition.key];
      }

      const used = await queryDefinitionUsage({definition, subject, at});
      return formatLimitCheck({
        key: definition.key,
        label: definition.label,
        used,
        projected: used,
        limit: 0,
        source: config.entitlementsEnabled ? "openmeter-customer-entitlement" : "openmeter",
      });
    }));
    const limits = Object.fromEntries(checks.map((check) => [check.key, check.limit]));

    return {
      allowed: checks.every((check) => !check.blocked),
      reasons: checks.filter((check) => check.blocked).map((check) => `${check.label} limit reached (${check.used}/${check.limit})`),
      checks,
      limits,
      source: config.entitlementsEnabled ? "openmeter-customer-entitlement" : "openmeter",
      customerKey,
    };
  }

  async function getTokenMetrics({accountState, periodDays = 7, selectedTokenId = "all"}) {
    const normalizedDays = [1, 7, 30, 90].includes(Number(periodDays)) ? Number(periodDays) : 7;
    const metrics = emptyMetrics({periodDays: normalizedDays, selectedTokenId, enabled: config.enabled});

    if (!config.enabled) {
      return metrics;
    }

    const account = accountState?.account || {};
    const tokens = Array.isArray(accountState?.tokens) ? accountState.tokens : [];
    const selectedTokens = selectedTokenId && selectedTokenId !== "all"
      ? tokens.filter((token) => token.id === selectedTokenId)
      : tokens;
    const selectedIds = new Set(selectedTokens.map((token) => token.id));
    const from = rangeStartForDays(normalizedDays);
    const to = now();
    const windowSize = normalizedDays === 1 ? "HOUR" : "DAY";

    tokens.forEach((token) => {
      metrics.byToken[token.id] = emptyTokenMetric();
      metrics.requestByToken[token.id] = metrics.byToken[token.id];
    });

    if (!tokens.length) {
      return metrics;
    }

    const [totalRows, promptRows, completionRows, costRows, requestRows, limitEntries] = await Promise.all([
      queryRowsForTokens(config.meterSlug, {tokens, account, from, to, windowSize}),
      queryRowsForTokens(config.promptMeterSlug, {tokens, account, from, to, windowSize}),
      queryRowsForTokens(config.completionMeterSlug, {tokens, account, from, to, windowSize}),
      queryRowsForTokens(config.costMeterSlug, {tokens, account, from, to, windowSize}),
      queryRowsForTokens(config.requestMeterSlug, {
        tokens,
        account,
        from,
        to,
        windowSize,
        groupBy: ["status", "http_status", "error_type", "failure_stage"],
      }),
      Promise.all(tokens.map(async (token) => [token.id, await getLimitSnapshot({token, account})])),
    ]);

    metrics.limitByToken = Object.fromEntries(limitEntries);

    totalRows.forEach((row) => addTokenValue(metrics.byToken, tokenIdFromRow(row), "totalTokens", row.value));
    promptRows.forEach((row) => addTokenValue(metrics.byToken, tokenIdFromRow(row), "promptTokens", row.value));
    completionRows.forEach((row) => addTokenValue(metrics.byToken, tokenIdFromRow(row), "responseTokens", row.value));
    costRows.forEach((row) => addTokenValue(metrics.byToken, tokenIdFromRow(row), "price", row.value));

    requestRows.forEach((row) => {
      const tokenId = tokenIdFromRow(row);
      const status = normalizeStatus(row?.groupBy?.status, row?.groupBy?.http_status);
      const value = Number(row?.value || 0);

      addTokenValue(metrics.byToken, tokenId, "requests", value);
      addTokenValue(metrics.byToken, tokenId, status === "success" ? "success" : "failed", value);
    });

    Object.values(metrics.byToken).forEach((summary) => {
      summary.successRate = summary.requests > 0 ? (summary.success / summary.requests) * 100 : null;
    });

    metrics.totals = Object.values(metrics.byToken).reduce((result, summary) => ({
      requests: result.requests + summary.requests,
      success: result.success + summary.success,
      failed: result.failed + summary.failed,
      successRate: null,
      promptTokens: result.promptTokens + summary.promptTokens,
      responseTokens: result.responseTokens + summary.responseTokens,
      totalTokens: result.totalTokens + summary.totalTokens,
      price: result.price + summary.price,
    }), metrics.totals);
    metrics.totals.successRate = metrics.totals.requests > 0 ? (metrics.totals.success / metrics.totals.requests) * 100 : null;
    metrics.selectedTotals = Object.entries(metrics.byToken)
      .filter(([tokenId]) => !selectedIds.size || selectedIds.has(tokenId))
      .map(([, summary]) => summary)
      .reduce((result, summary) => ({
        requests: result.requests + summary.requests,
        success: result.success + summary.success,
        failed: result.failed + summary.failed,
        successRate: null,
        promptTokens: result.promptTokens + summary.promptTokens,
        responseTokens: result.responseTokens + summary.responseTokens,
        totalTokens: result.totalTokens + summary.totalTokens,
        price: result.price + summary.price,
      }), metrics.selectedTotals);
    metrics.selectedTotals.successRate = metrics.selectedTotals.requests > 0 ? (metrics.selectedTotals.success / metrics.selectedTotals.requests) * 100 : null;

    const usageByKey = new Map(metrics.usageSeries.map((bucket) => [bucket.key, bucket]));
    totalRows.forEach((row) => addSeriesValue(usageByKey, row, normalizedDays, selectedIds, "totalTokens"));
    promptRows.forEach((row) => addSeriesValue(usageByKey, row, normalizedDays, selectedIds, "promptTokens"));
    completionRows.forEach((row) => addSeriesValue(usageByKey, row, normalizedDays, selectedIds, "responseTokens"));
    costRows.forEach((row) => addSeriesValue(usageByKey, row, normalizedDays, selectedIds, "price"));

    const requestByKey = new Map(metrics.requestSeries.map((bucket) => [bucket.key, bucket]));
    const failureStatusSeries = buildMetricBuckets(normalizedDays);
    const failureStatusByKey = new Map(failureStatusSeries.map((bucket) => [bucket.key, bucket]));
    const failedStatusCodes = new Set();
    const failureCounts = {};

    requestRows.forEach((row) => {
      const tokenId = tokenIdFromRow(row);
      if (selectedIds.size && !selectedIds.has(tokenId)) {
        return;
      }

      const date = new Date(row?.windowStart || "");
      if (Number.isNaN(date.getTime())) {
        return;
      }

      const key = bucketKeyFor(date, normalizedDays);
      const status = normalizeStatus(row?.groupBy?.status, row?.groupBy?.http_status);
      const value = Number(row?.value || 0);
      const bucket = requestByKey.get(key);

      if (bucket) {
        if (status === "success") {
          bucket.success += value;
          const usageBucket = usageByKey.get(key);
          if (usageBucket) {
            usageBucket.requests += value;
          }
        } else {
          bucket.failed += value;
        }
        bucket.total += value;
      }

      if (status !== "success") {
        const failureBucket = failureStatusByKey.get(key);
        const httpStatus = String(row?.groupBy?.http_status || "unknown");
        const statusKey = `status_${httpStatus.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const failureType = row?.groupBy?.error_type || row?.groupBy?.failure_stage || "unknown";

        failedStatusCodes.add(httpStatus);
        failureCounts[failureType] = (failureCounts[failureType] || 0) + value;
        if (failureBucket) {
          failureBucket[statusKey] = Number(failureBucket[statusKey] || 0) + value;
        }
      }
    });

    metrics.requestSeries = metrics.requestSeries.map((bucket) => ({
      ...bucket,
      successRate: bucket.total > 0 ? (bucket.success / bucket.total) * 100 : null,
    }));
    metrics.failedStatusChart = {
      series: failureStatusSeries,
      lines: [...failedStatusCodes].sort().map((statusCode, index) => ({
        key: `status_${statusCode.replace(/[^a-zA-Z0-9]/g, "_")}`,
        label: statusCode === "unknown" ? "Unknown status" : `HTTP ${statusCode}`,
        className: `line-status-${index % 6}`,
      })),
    };
    metrics.failureBreakdown = Object.entries(failureCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6);

    return metrics;
  }

  return {
    enabled: config.enabled,
    config: publicConfig(config),
    subjectFor,
    recordUsage,
    recordRequestFailure,
    checkTokenLimits,
    syncTokenEntitlements,
    deleteTokenEntitlements,
    getTokenMetrics,
  };
}
