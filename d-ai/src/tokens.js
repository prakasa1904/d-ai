const storagePrefix = "d-ai.token-state";

export function emptyTokenState() {
  return {
    version: 1,
    tokens: [],
    usage: [],
  };
}

function storageKey(account) {
  return `${storagePrefix}.${account.owner}.${account.name}`;
}

export function defaultTokenLimits() {
  return {
    totalTokens: 0,
    requestsPerMinute: 0,
    requestsPerHour: 0,
    requestsPerDay: 0,
    tokensPerDay: 0,
  };
}

export function normalizeTokenLimits(limits = {}) {
  const defaults = defaultTokenLimits();

  return Object.fromEntries(Object.keys(defaults).map((key) => {
    const value = Math.max(0, Math.floor(Number(limits[key] || 0)));
    return [key, value];
  }));
}

function normalizeToken(token) {
  return {
    ...token,
    limits: normalizeTokenLimits(token?.limits),
  };
}

function randomText(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function loadTokenState(account) {
  if (!account) {
    return emptyTokenState();
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(account)) || "");
    return {
      ...emptyTokenState(),
      ...parsed,
      tokens: Array.isArray(parsed?.tokens) ? parsed.tokens.map(normalizeToken) : [],
      usage: Array.isArray(parsed?.usage) ? parsed.usage : [],
    };
  } catch {
    return emptyTokenState();
  }
}

export function saveTokenState(account, state) {
  if (!account) {
    return;
  }

  localStorage.setItem(storageKey(account), JSON.stringify({
    ...emptyTokenState(),
    ...state,
    version: 1,
  }));
}

export function createTokenRecord(name, limits = {}) {
  const createdAt = new Date().toISOString();
  const suffix = randomText(5).toLowerCase();

  return {
    id: `tok_${Date.now()}_${suffix}`,
    name: name.trim() || `D-AI Token ${suffix.slice(0, 4)}`,
    value: `dai_${randomText(32)}`,
    status: "Active",
    createdAt,
    lastUsedAt: "",
    limits: normalizeTokenLimits(limits),
  };
}

export function isTokenActive(token) {
  return token.status === "Active";
}

export function maskToken(value) {
  if (!value) {
    return "";
  }

  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

export function estimateTokenCount(text) {
  const content = String(text || "").trim();
  if (!content) {
    return 0;
  }

  return Math.max(1, Math.ceil(content.length / 4));
}

export function messageTokenCount(message) {
  if (!message) {
    return 0;
  }

  return Number(message.tokenCount || 0) || Number(message.textTokenCount || 0) || estimateTokenCount(message.text);
}

export function createUsageRecord({tokenId, chat, messages, answerName, promptText}) {
  const answer = messages.find((message) => message.name === answerName) ||
    [...messages].reverse().find((message) => message.author === "AI");
  const prompt = answer?.replyTo
    ? messages.find((message) => message.name === answer.replyTo)
    : [...messages].reverse().find((message) => message.author !== "AI" && message.text === promptText);
  const promptTokens = messageTokenCount(prompt) || estimateTokenCount(promptText);
  const responseTokens = messageTokenCount(answer);
  const price = Number(prompt?.price || 0) + Number(answer?.price || 0);

  return {
    id: `use_${Date.now()}_${randomText(4).toLowerCase()}`,
    tokenId,
    createdAt: new Date().toISOString(),
    chatName: chat?.name || "",
    chatTitle: chat?.displayName || chat?.name || "",
    promptName: prompt?.name || "",
    answerName: answer?.name || "",
    promptTokens,
    responseTokens,
    totalTokens: promptTokens + responseTokens,
    price,
    currency: answer?.currency || prompt?.currency || "",
  };
}

export function getTokenUsageSummary(state) {
  const byToken = {};
  const totals = {
    requests: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    price: 0,
  };

  state.usage.forEach((entry) => {
    if (!byToken[entry.tokenId]) {
      byToken[entry.tokenId] = {
        requests: 0,
        promptTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
        price: 0,
        lastUsedAt: "",
      };
    }

    const summary = byToken[entry.tokenId];
    summary.requests += 1;
    summary.promptTokens += Number(entry.promptTokens || 0);
    summary.responseTokens += Number(entry.responseTokens || 0);
    summary.totalTokens += Number(entry.totalTokens || 0);
    summary.price += Number(entry.price || 0);
    if (!summary.lastUsedAt || entry.createdAt > summary.lastUsedAt) {
      summary.lastUsedAt = entry.createdAt;
    }

    totals.requests += 1;
    totals.promptTokens += Number(entry.promptTokens || 0);
    totals.responseTokens += Number(entry.responseTokens || 0);
    totals.totalTokens += Number(entry.totalTokens || 0);
    totals.price += Number(entry.price || 0);
  });

  return {byToken, totals};
}

function startOfToday(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function sumUsage(entries) {
  return entries.reduce((result, entry) => ({
    requests: result.requests + 1,
    promptTokens: result.promptTokens + Number(entry.promptTokens || 0),
    responseTokens: result.responseTokens + Number(entry.responseTokens || 0),
    totalTokens: result.totalTokens + Number(entry.totalTokens || 0),
  }), {
    requests: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
  });
}

export function getTokenWindowStats(usage, tokenId, now = new Date()) {
  const nowTime = new Date(now).getTime();
  const minuteStart = nowTime - 60 * 1000;
  const hourStart = nowTime - 60 * 60 * 1000;
  const dayStart = startOfToday(now).getTime();
  const entries = usage.filter((entry) => entry.tokenId === tokenId);

  return {
    all: sumUsage(entries),
    minute: sumUsage(entries.filter((entry) => new Date(entry.createdAt || "").getTime() >= minuteStart)),
    hour: sumUsage(entries.filter((entry) => new Date(entry.createdAt || "").getTime() >= hourStart)),
    day: sumUsage(entries.filter((entry) => new Date(entry.createdAt || "").getTime() >= dayStart)),
  };
}

export function getTokenLimitStatus(token, usage, pendingTokens = 0, now = new Date()) {
  if (!token) {
    return {
      allowed: true,
      reasons: [],
      checks: [],
      stats: null,
      limits: defaultTokenLimits(),
    };
  }

  const limits = normalizeTokenLimits(token.limits);
  const stats = getTokenWindowStats(usage, token.id, now);
  const checks = [
    {
      key: "totalTokens",
      label: "Total token quota",
      used: stats.all.totalTokens,
      projected: stats.all.totalTokens + Number(pendingTokens || 0),
      limit: limits.totalTokens,
      required: true,
    },
    {
      key: "requestsPerMinute",
      label: "Requests / minute",
      used: stats.minute.requests,
      projected: stats.minute.requests + 1,
      limit: limits.requestsPerMinute,
    },
    {
      key: "requestsPerHour",
      label: "Requests / hour",
      used: stats.hour.requests,
      projected: stats.hour.requests + 1,
      limit: limits.requestsPerHour,
    },
    {
      key: "requestsPerDay",
      label: "Requests / day",
      used: stats.day.requests,
      projected: stats.day.requests + 1,
      limit: limits.requestsPerDay,
    },
    {
      key: "tokensPerDay",
      label: "Tokens / day",
      used: stats.day.totalTokens,
      projected: stats.day.totalTokens + Number(pendingTokens || 0),
      limit: limits.tokensPerDay,
    },
  ].map((check) => {
    const missing = Boolean(check.required && check.limit <= 0);
    const exceeded = !missing && check.limit > 0 && check.projected > check.limit;

    return {
      ...check,
      missing,
      remaining: check.limit > 0 ? Math.max(0, check.limit - check.used) : Infinity,
      exceeded,
      blocked: missing || exceeded,
    };
  });
  const blocked = checks.filter((check) => check.blocked);

  return {
    allowed: blocked.length === 0,
    reasons: blocked.map((check) => check.missing
      ? `${check.label} must be set`
      : `${check.label} limit reached (${check.used}/${check.limit})`),
    checks,
    stats,
    limits,
  };
}
