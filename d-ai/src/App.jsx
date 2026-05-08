import {useEffect, useMemo, useRef, useState} from "react";
import {
  chooseStore,
  checkTokenLimit,
  createChat,
  deleteChat,
  getAccount,
  getChats,
  getMessages,
  getServerTokenState,
  getStores,
  loginWithPassword,
  mutateTokenState,
  openAnswerStream,
  registerWithPassword,
  sendChatMessage,
  signOut,
  syncTokenState,
  updateChat,
  updateMessage,
  uploadStoreFile,
  getUserProfile,
  hasCasdoorProfileToken,
  refreshCasdoorProfileToken,
  updateUserProfile,
} from "./api";
import {
  createUsageRecord,
  emptyTokenState,
  estimateTokenCount,
  getTokenLimitStatus,
  getTokenUsageSummary,
  isTokenActive,
  loadTokenState,
  maskToken,
  normalizeTokenLimits,
  saveTokenState,
} from "./tokens";

function displayName(account) {
  return account?.displayName || account?.name || "User";
}

function initialsFor(account) {
  return displayName(account)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U";
}

function roleOf(message, account) {
  if (message.author === "AI") {
    return "assistant";
  }

  if (message.author === account?.name) {
    return "user";
  }

  return "system";
}

function formatChatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatFullTime(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const imageFileExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

function attachmentId(file) {
  return `attachment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.name}`;
}

function fileExtension(fileName) {
  const dotIndex = String(fileName || "").lastIndexOf(".");
  return dotIndex >= 0 ? String(fileName).slice(dotIndex).toLowerCase() : "";
}

function isImageFile(file) {
  const type = file?.type || "";
  return type.startsWith("image/") || imageFileExtensions.has(fileExtension(file?.name));
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function attachmentImageUrl(attachment) {
  const record = attachment?.record || {};
  return attachment?.url
    || record.url
    || record.downloadUrl
    || record.fileUrl
    || record.objectUrl
    || "";
}

function buildAttachmentPrompt(text, attachments) {
  if (!attachments.length) {
    return text;
  }

  const sections = attachments.map((attachment, index) => {
    const imageUrl = attachmentImageUrl(attachment);
    const lines = [
      `Image ${index + 1}: ${attachment.filename}`,
      `Storage object: ${attachment.objectKey}`,
      `Size: ${formatFileSize(attachment.size)}`,
    ];

    if (attachment.type) {
      lines.push(`Media type: ${attachment.type}`);
    }

    if (imageUrl) {
      lines.push(`Image URL: ${imageUrl}`);
    } else {
      lines.push("Image URL: unavailable; the image is stored in the selected Casibase store.");
    }

    return lines.join("\n");
  });

  return [
    text || "Please analyze the attached image.",
    "",
    "Use these uploaded images as visual context for the answer:",
    sections.join("\n\n"),
  ].join("\n");
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function wordsIn(messages) {
  return messages.reduce((total, message) => {
    const words = String(message.text || "").trim().split(/\s+/).filter(Boolean);
    return total + words.length;
  }, 0);
}

function countBy(items, getKey) {
  return items.reduce((result, item) => {
    const key = getKey(item) || "Unknown";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function topEntries(counts, limit = 5) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

const dashboardPeriodOptions = [
  {value: 1, label: "1 day"},
  {value: 7, label: "7 days"},
  {value: 30, label: "30 days"},
  {value: 90, label: "90 days"},
];

function periodLabel(days) {
  return dashboardPeriodOptions.find((option) => option.value === days)?.label || `${days} days`;
}

function rangeStartForDays(days) {
  const today = startOfToday();
  const rangeStart = new Date(today);
  rangeStart.setDate(today.getDate() - Math.max(0, days - 1));
  return rangeStart;
}

function dateInRange(value, rangeStart) {
  const date = new Date(value || "");
  return !Number.isNaN(date.getTime()) && date >= rangeStart;
}

function shortDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric"}).format(date);
}

function buildDailyUsage(messages, days = 7) {
  const series = [];
  const today = startOfToday();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    series.push({
      key: localDateKey(day),
      label: new Intl.DateTimeFormat(undefined, days <= 7 ? {weekday: "short"} : {month: "short", day: "numeric"}).format(day),
      count: 0,
    });
  }

  const index = new Map(series.map((day) => [day.key, day]));
  messages.forEach((message) => {
    const date = new Date(message.createdTime || "");
    if (!Number.isNaN(date.getTime())) {
      const day = index.get(localDateKey(date));
      if (day) {
        day.count += 1;
      }
    }
  });

  return series;
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildTokenUsageSeries(usage, days = 14) {
  const today = startOfToday();
  const series = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    series.push({
      key: localDateKey(date),
      label: new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric"}).format(date),
      requests: 0,
      promptTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      price: 0,
    });
  }

  const byDay = new Map(series.map((day) => [day.key, day]));
  usage.forEach((entry) => {
    const date = new Date(entry.createdAt || "");
    if (Number.isNaN(date.getTime())) {
      return;
    }

    const day = byDay.get(localDateKey(date));
    if (!day) {
      return;
    }

    day.requests += 1;
    day.promptTokens += Number(entry.promptTokens || 0);
    day.responseTokens += Number(entry.responseTokens || 0);
    day.totalTokens += Number(entry.totalTokens || 0);
    day.price += Number(entry.price || 0);
  });

  return series;
}

function localHourKey(date) {
  return [
    localDateKey(date),
    String(date.getHours()).padStart(2, "0"),
  ].join("T");
}

function buildMonitoringBuckets(days) {
  if (days === 1) {
    const start = startOfToday();
    return Array.from({length: 24}, (_, hour) => {
      const date = new Date(start);
      date.setHours(hour, 0, 0, 0);
      return {
        key: localHourKey(date),
        label: new Intl.DateTimeFormat(undefined, {hour: "2-digit"}).format(date),
        success: 0,
        failed: 0,
        total: 0,
        successRate: null,
      };
    });
  }

  const today = startOfToday();
  return Array.from({length: days}, (_, index) => {
    const offset = days - 1 - index;
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    return {
      key: localDateKey(date),
      label: new Intl.DateTimeFormat(undefined, days <= 7 ? {weekday: "short"} : {month: "short", day: "numeric"}).format(date),
      success: 0,
      failed: 0,
      total: 0,
      successRate: null,
    };
  });
}

function buildTokenRequestEvents(tokenData) {
  const events = Array.isArray(tokenData.requestEvents) ? tokenData.requestEvents : [];
  const usageWithEvents = new Set(events.map((event) => event.usageId).filter(Boolean));
  const syntheticSuccessEvents = (tokenData.usage || [])
    .filter((entry) => entry.id && !usageWithEvents.has(entry.id))
    .map((entry) => ({
      id: `synthetic_${entry.id}`,
      tokenId: entry.tokenId,
      createdAt: entry.createdAt,
      status: "success",
      source: "usage",
      httpStatus: 200,
      errorType: "",
      errorMessage: "",
      failureStage: "",
      promptTokens: Number(entry.promptTokens || 0),
      responseTokens: Number(entry.responseTokens || 0),
      totalTokens: Number(entry.totalTokens || 0),
      latencyMs: 0,
      historyKey: entry.historyKey || "",
      chatName: entry.chatName || "",
      chatTitle: entry.chatTitle || "",
      modelProvider: entry.modelProvider || "",
      usageId: entry.id,
      isSynthetic: true,
    }));

  return [...events, ...syntheticSuccessEvents];
}

function buildTokenRequestSeries(events, days) {
  const series = buildMonitoringBuckets(days);
  const byKey = new Map(series.map((bucket) => [bucket.key, bucket]));

  events.forEach((event) => {
    const date = new Date(event.createdAt || "");
    if (Number.isNaN(date.getTime())) {
      return;
    }

    const bucket = byKey.get(days === 1 ? localHourKey(date) : localDateKey(date));
    if (!bucket) {
      return;
    }

    if (event.status === "success") {
      bucket.success += 1;
    } else {
      bucket.failed += 1;
    }
    bucket.total += 1;
  });

  return series.map((bucket) => ({
    ...bucket,
    successRate: bucket.total > 0 ? (bucket.success / bucket.total) * 100 : null,
  }));
}

function statusCodeKey(statusCode) {
  const value = String(statusCode || "unknown").trim() || "unknown";
  return `status_${value.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function statusCodeLabel(statusCode) {
  const value = String(statusCode || "unknown").trim();
  return value ? `HTTP ${value}` : "Unknown status";
}

function buildFailedStatusSeries(events, days) {
  const series = buildMonitoringBuckets(days);
  const byKey = new Map(series.map((bucket) => [bucket.key, bucket]));
  const statusCodes = new Set();

  events
    .filter((event) => event.status !== "success")
    .forEach((event) => {
      const date = new Date(event.createdAt || "");
      if (Number.isNaN(date.getTime())) {
        return;
      }

      const bucket = byKey.get(days === 1 ? localHourKey(date) : localDateKey(date));
      if (!bucket) {
        return;
      }

      const statusCode = event.httpStatus || "unknown";
      const key = statusCodeKey(statusCode);
      statusCodes.add(String(statusCode));
      bucket[key] = Number(bucket[key] || 0) + 1;
    });

  const sortedStatusCodes = [...statusCodes].sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
    return left.localeCompare(right);
  });
  const lines = sortedStatusCodes.map((statusCode, index) => ({
    key: statusCodeKey(statusCode),
    label: statusCodeLabel(statusCode),
    className: `line-status-${index % 6}`,
  }));

  return {series, lines};
}

function summarizeRequestEvents(events) {
  const summary = events.reduce((result, event) => {
    result.total += 1;
    if (event.status === "success") {
      result.success += 1;
    } else {
      result.failed += 1;
    }
    return result;
  }, {total: 0, success: 0, failed: 0});

  return {
    ...summary,
    successRate: summary.total > 0 ? (summary.success / summary.total) * 100 : null,
  };
}

function summarizeRequestsByToken(events) {
  return events.reduce((result, event) => {
    if (!result[event.tokenId]) {
      result[event.tokenId] = {
        total: 0,
        success: 0,
        failed: 0,
        successRate: null,
        lastSuccessAt: "",
        lastFailureAt: "",
        lastFailureReason: "",
      };
    }

    const item = result[event.tokenId];
    item.total += 1;
    if (event.status === "success") {
      item.success += 1;
      if (!item.lastSuccessAt || event.createdAt > item.lastSuccessAt) {
        item.lastSuccessAt = event.createdAt;
      }
    } else {
      item.failed += 1;
      if (!item.lastFailureAt || event.createdAt > item.lastFailureAt) {
        item.lastFailureAt = event.createdAt;
        item.lastFailureReason = event.errorMessage || event.errorType || event.failureStage || "Failed";
      }
    }
    item.successRate = item.total > 0 ? (item.success / item.total) * 100 : null;

    return result;
  }, {});
}

function failureBreakdown(events, limit = 6) {
  const counts = countBy(
    events.filter((event) => event.status !== "success"),
    (event) => event.errorType || event.failureStage || "unknown",
  );
  return topEntries(counts, limit);
}

function tokenLogSummary(events) {
  return events.reduce((summary, event) => {
    summary.total += 1;
    summary.promptTokens += Number(event.promptTokens || 0);
    summary.responseTokens += Number(event.responseTokens || 0);
    summary.totalTokens += Number(event.totalTokens || 0);

    if (event.status === "success") {
      summary.success += 1;
    } else {
      summary.failed += 1;
    }

    if (!summary.lastSeenAt || String(event.createdAt || "").localeCompare(summary.lastSeenAt) > 0) {
      summary.lastSeenAt = event.createdAt || "";
    }

    return summary;
  }, {
    total: 0,
    success: 0,
    failed: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    lastSeenAt: "",
  });
}

function requestLogDetail(entry) {
  if (entry.status === "success") {
    return entry.chatTitle || entry.chatName || entry.historyKey || entry.source || "Completed";
  }

  return entry.errorMessage || entry.errorType || entry.failureStage || "Failed";
}

function requestLogSource(entry) {
  const source = entry.source || "unknown";
  const historyKey = entry.historyKey || "";
  return historyKey ? `${source} · ${historyKey}` : source;
}

function requestLogHttpStatus(entry) {
  const value = entry.httpStatus || (entry.status === "success" ? 200 : "");
  return value ? `HTTP ${value}` : "No status";
}

function requestLogLatency(entry) {
  const latencyMs = Number(entry.latencyMs || 0);
  return latencyMs > 0 ? `${latencyMs.toLocaleString()} ms` : "No latency";
}

function formatPercent(value) {
  return value === null || value === undefined ? "No traffic" : `${value.toFixed(value >= 99.95 || value < 10 ? 1 : 0)}%`;
}

function AppHeader({currentPath, onNavigate, onLogout, onNewChat}) {
  const eyebrow = currentPath === "/dashboard"
    ? "User usage"
    : currentPath === "/tokens"
      ? "Token management"
      : currentPath === "/profile"
        ? "User profile"
        : "Casibase chat API";

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>D-AI</h1>
      </div>
      <div className="account-bar">
        <button className="ghost-button" onClick={() => onNavigate("/")}>Chat</button>
        <button className="ghost-button" onClick={() => onNavigate("/dashboard")}>Dashboard</button>
        <button className="ghost-button" onClick={() => onNavigate("/tokens")}>Tokens</button>
        <button className="ghost-button" onClick={() => onNavigate("/profile")}>Profile</button>
        {onNewChat ? <button className="ghost-button" onClick={onNewChat}>New chat</button> : null}
        <button className="ghost-button" onClick={onLogout}>Sign out</button>
      </div>
    </header>
  );
}

function LoginPage({onLogin}) {
  const [username, setUsername] = useState("user");
  const [password, setPassword] = useState("");
  const [displayNameValue, setDisplayNameValue] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState("signin");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const isRegister = mode === "register";

  function selectMode(nextMode) {
    setMode(nextMode);
    setError("");

    if (nextMode === "register" && username === "user") {
      setUsername("");
      setPassword("");
      setConfirmPassword("");
    }

    if (nextMode === "signin" && !username.trim()) {
      setUsername("user");
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setIsBusy(true);

    try {
      const cleanUsername = username.trim();
      const cleanDisplayName = displayNameValue.trim();

      if (isRegister) {
        if (!cleanDisplayName) {
          throw new Error("Display name is required.");
        }

        if (password.length < 6) {
          throw new Error("Password must be at least 6 characters.");
        }

        if (password !== confirmPassword) {
          throw new Error("Password confirmation does not match.");
        }

        await registerWithPassword({
          username: cleanUsername,
          displayName: cleanDisplayName,
          password,
        });
      } else {
        await loginWithPassword(cleanUsername, password);
      }

      const account = await getAccount();
      onLogin(account);
    } catch (error) {
      setError(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-mark">D</div>
        <div>
          <p className="eyebrow">Casdoor session</p>
          <h1 id="login-title">D-AI</h1>
          <p className="muted">{isRegister ? "Create a Casdoor account for D-AI." : "Sign in with your local Casdoor user to open the Casibase chat API."}</p>
        </div>

        <div className="auth-switch" role="tablist" aria-label="Authentication mode">
          <button
            aria-selected={!isRegister}
            className={`auth-switch-button ${!isRegister ? "active" : ""}`}
            disabled={isBusy}
            onClick={() => selectMode("signin")}
            role="tab"
            type="button"
          >
            Sign in
          </button>
          <button
            aria-selected={isRegister}
            className={`auth-switch-button ${isRegister ? "active" : ""}`}
            disabled={isBusy}
            onClick={() => selectMode("register")}
            role="tab"
            type="button"
          >
            Register
          </button>
        </div>

        <form className="login-form" onSubmit={submit}>
          {isRegister ? (
            <>
              <label>
                Display name
                <input
                  autoComplete="name"
                  disabled={isBusy}
                  value={displayNameValue}
                  onChange={(event) => setDisplayNameValue(event.target.value)}
                  placeholder="Your name"
                  required
                />
              </label>
            </>
          ) : null}

          <label>
            Username
            <input
              autoComplete="username"
              disabled={isBusy}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={isRegister ? "username" : "user"}
              required
            />
          </label>

          <label>
            Password
            <input
              autoComplete={isRegister ? "new-password" : "current-password"}
              disabled={isBusy}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              required
            />
          </label>

          {isRegister ? (
            <label>
              Confirm password
              <input
                autoComplete="new-password"
                disabled={isBusy}
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Confirm password"
                required
              />
            </label>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}

          <button className="primary-button" disabled={isBusy}>
            {isBusy ? (isRegister ? "Creating..." : "Signing in...") : (isRegister ? "Create account" : "Sign in")}
          </button>
        </form>
      </section>
    </main>
  );
}

function StatCard({label, value, detail}) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function UsageBreakdown({title, entries}) {
  const max = Math.max(1, ...entries.map((entry) => entry[1]));

  return (
    <section className="dashboard-section">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      {entries.length === 0 ? (
        <p className="side-note">No data yet.</p>
      ) : (
        <div className="usage-bars">
          {entries.map(([label, count]) => (
            <div className="usage-row" key={label}>
              <div>
                <span>{label}</span>
                <strong>{count}</strong>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{width: `${Math.max(8, (count / max) * 100)}%`}} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TimeseriesLineChart({series, lines, maxValue, valueFormatter = (value) => value.toLocaleString()}) {
  const width = 720;
  const height = 240;
  const padding = {top: 18, right: 20, bottom: 34, left: 46};
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = series.flatMap((item) => lines.map((line) => Number(item[line.key] || 0)));
  const max = Math.max(1, Number(maxValue || 0), ...values);
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));

  function pointFor(item, index, key) {
    const value = Number(item[key] || 0);
    const x = padding.left + (series.length <= 1 ? chartWidth / 2 : (index / (series.length - 1)) * chartWidth);
    const y = padding.top + chartHeight - (value / max) * chartHeight;
    return {x, y, value};
  }

  return (
    <div className="line-chart-scroll">
      <svg className="line-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
        {[0, 0.5, 1].map((tick) => {
          const y = padding.top + chartHeight - tick * chartHeight;
          const value = max * tick;

          return (
            <g key={tick}>
              <line className="line-chart-grid" x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
              <text className="line-chart-y-label" x={padding.left - 10} y={y + 4}>{valueFormatter(value)}</text>
            </g>
          );
        })}

        {lines.map((line) => {
          const points = series.map((item, index) => pointFor(item, index, line.key));
          const path = points.map((point) => `${point.x},${point.y}`).join(" ");

          return (
            <g key={line.key}>
              <polyline className={`line-chart-line ${line.className || ""}`} points={path} />
              {points.map((point, index) => (
                <g key={`${line.key}-${series[index].key}`}>
                  {series.length <= 30 ? (
                    <circle
                      className={`line-chart-dot ${line.className || ""}`}
                      cx={point.x}
                      cy={point.y}
                      r="3"
                    />
                  ) : null}
                  <circle className="line-chart-hit-dot" cx={point.x} cy={point.y} r="8">
                    <title>{`${series[index].label}: ${line.label} ${valueFormatter(point.value)}`}</title>
                  </circle>
                </g>
              ))}
            </g>
          );
        })}

        {series.map((item, index) => {
          if (index !== 0 && index !== series.length - 1 && index % labelEvery !== 0) {
            return null;
          }

          const x = padding.left + (series.length <= 1 ? chartWidth / 2 : (index / (series.length - 1)) * chartWidth);
          return <text className="line-chart-x-label" key={item.key} x={x} y={height - 8}>{item.label}</text>;
        })}
      </svg>
    </div>
  );
}

function DailyActivity({days, title}) {
  return (
    <section className="dashboard-section">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <TimeseriesLineChart
        lines={[{key: "count", label: "Messages", className: "line-activity"}]}
        series={days}
      />
    </section>
  );
}

function TokenUsageTimeseries({periodLabelText, series, tokens, selectedTokenId, onSelectedTokenId}) {
  const totals = series.reduce((result, day) => ({
    requests: result.requests + day.requests,
    totalTokens: result.totalTokens + day.totalTokens,
    promptTokens: result.promptTokens + day.promptTokens,
    responseTokens: result.responseTokens + day.responseTokens,
  }), {requests: 0, totalTokens: 0, promptTokens: 0, responseTokens: 0});

  return (
    <section className="dashboard-section token-timeseries-section">
      <div className="section-heading token-chart-heading">
        <div>
          <h2>Token Usage Over Time</h2>
          <p className="side-note">
            {periodLabelText} · {totals.requests} requests · {totals.totalTokens} tokens · {totals.promptTokens} prompt · {totals.responseTokens} response
          </p>
        </div>
        <select value={selectedTokenId} onChange={(event) => onSelectedTokenId(event.target.value)}>
          <option value="all">All tokens</option>
          {tokens.map((token) => (
            <option key={token.id} value={token.id}>{token.name}</option>
          ))}
        </select>
      </div>

      {totals.requests === 0 ? (
        <p className="side-note">No token usage in this time window yet.</p>
      ) : (
        <TimeseriesLineChart
          lines={[
            {key: "promptTokens", label: "Prompt tokens", className: "line-prompt"},
            {key: "responseTokens", label: "Response tokens", className: "line-response"},
            {key: "requests", label: "Requests", className: "line-requests"},
          ]}
          series={series}
        />
      )}

      <div className="chart-legend">
        <span><i className="legend-prompt" /> Prompt tokens</span>
        <span><i className="legend-response" /> Response tokens</span>
        <span><i className="legend-requests" /> Requests</span>
      </div>
    </section>
  );
}

function TokenRequestMonitoring({failureStatusLines, failureStatusSeries, periodLabelText, series}) {
  const totals = series.reduce((result, bucket) => ({
    total: result.total + bucket.total,
    success: result.success + bucket.success,
    failed: result.failed + bucket.failed,
  }), {total: 0, success: 0, failed: 0});

  return (
    <div className="monitoring-grid">
      <section className="dashboard-section token-section">
        <div className="section-heading">
          <div>
            <h2>Request Success Rate</h2>
            <p className="side-note">{periodLabelText} · {formatPercent(totals.total ? (totals.success / totals.total) * 100 : null)} overall</p>
          </div>
        </div>
        <TimeseriesLineChart
          lines={[{key: "successRate", label: "Success rate", className: "line-success"}]}
          maxValue={100}
          series={series.map((bucket) => ({...bucket, successRate: bucket.successRate ?? 0}))}
          valueFormatter={(value) => `${Math.round(value)}%`}
        />
      </section>

      <section className="dashboard-section token-section">
        <div className="section-heading">
          <div>
            <h2>Failed Requests</h2>
            <p className="side-note">{periodLabelText} · {totals.failed} failed of {totals.total} attempts</p>
          </div>
        </div>
        {failureStatusLines.length ? (
          <>
            <TimeseriesLineChart lines={failureStatusLines} series={failureStatusSeries} />
            <div className="chart-legend">
              {failureStatusLines.map((line) => (
                <span key={line.key}><i className={line.className} /> {line.label}</span>
              ))}
            </div>
          </>
        ) : (
          <p className="side-note">No failed requests in this time window yet.</p>
        )}
      </section>
    </div>
  );
}

function ApiReference({token, onCopy}) {
  const reference = useMemo(() => {
    const origin = window.location.origin;
    const baseUrl = `${origin}/api/v1`;
    const chatUrl = `${baseUrl}/chat/completions`;
    const model = "d-ai-casibase";
    const bearer = token?.value || "<TOKEN>";
    const historyKey = "default";

    return {
      baseUrl,
      chatUrl,
      casibaseUrl: `${origin}/casibase`,
      model,
      historyKey,
      authHeader: `Authorization: Bearer ${bearer}`,
      historyHeader: `X-D-AI-History-Key: ${historyKey}`,
      curl: [
        `curl '${chatUrl}' \\`,
        `  -H 'Authorization: Bearer ${bearer}' \\`,
        `  -H 'X-D-AI-History-Key: ${historyKey}' \\`,
        "  -H 'Content-Type: application/json' \\",
        "  --data '{",
        `    \"model\": \"${model}\",`,
        "    \"messages\": [{\"role\": \"user\", \"content\": \"Hello from D-AI\"}],",
        "    \"stream\": true",
        "  }'",
      ].join("\n"),
    };
  }, [token]);

  return (
    <section className="dashboard-section token-section api-reference-section">
      <div className="section-heading">
        <div>
          <h2>Custom Model API</h2>
          <p className="side-note">Use an active D-AI token and a stable history key to keep requests in the same Casibase chat.</p>
        </div>
      </div>

      <div className="api-grid">
        <div className="api-field">
          <span>Base URL</span>
          <code>{reference.baseUrl}</code>
          <button className="small-button" onClick={() => onCopy("Base URL", reference.baseUrl)}>Copy</button>
        </div>
        <div className="api-field">
          <span>Chat URL</span>
          <code>{reference.chatUrl}</code>
          <button className="small-button" onClick={() => onCopy("Chat URL", reference.chatUrl)}>Copy</button>
        </div>
        <div className="api-field">
          <span>Model</span>
          <code>{reference.model}</code>
          <button className="small-button" onClick={() => onCopy("Model", reference.model)}>Copy</button>
        </div>
        <div className="api-field">
          <span>Auth Header</span>
          <code>{reference.authHeader}</code>
          <button className="small-button" onClick={() => onCopy("Auth header", reference.authHeader)}>Copy</button>
        </div>
        <div className="api-field">
          <span>History Header</span>
          <code>{reference.historyHeader}</code>
          <button className="small-button" onClick={() => onCopy("History header", reference.historyHeader)}>Copy</button>
        </div>
        <div className="api-field">
          <span>History Key</span>
          <code>{reference.historyKey}</code>
          <button className="small-button" onClick={() => onCopy("History key", reference.historyKey)}>Copy</button>
        </div>
        <div className="api-field">
          <span>Casibase Proxy Base</span>
          <code>{reference.casibaseUrl}</code>
          <button className="small-button" onClick={() => onCopy("Casibase proxy base", reference.casibaseUrl)}>Copy</button>
        </div>
      </div>

      <div className="api-note">
        Reuse the same history key on every request to append to the same Casibase chat history. Omitting the header uses <code>default</code>; change the key only when you want a separate API conversation.
      </div>

      <div className="curl-block">
        <div className="section-heading">
          <h2>cURL</h2>
          <button className="small-button" onClick={() => onCopy("cURL", reference.curl)}>Copy</button>
        </div>
        <pre>{reference.curl}</pre>
      </div>
    </section>
  );
}

function limitText(value) {
  return value > 0 ? value.toLocaleString() : "Unlimited";
}

function LimitMeter({label, used, limit, missing}) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isExceeded = missing || (limit > 0 && used >= limit);

  return (
    <div className={`limit-meter ${missing ? "missing" : ""}`}>
      <div>
        <span>{label}</span>
        <strong>{used.toLocaleString()} / {limitText(limit)}</strong>
      </div>
      <div className="limit-track">
        <div className={`limit-fill ${isExceeded ? "exceeded" : ""}`} style={{width: `${percent}%`}} />
      </div>
    </div>
  );
}

function RateLimitTracker({tokenData, selectedTokenId, onSelectedTokenId, onUpdateTokenLimits}) {
  const token = tokenData.tokens.find((item) => item.id === selectedTokenId) || tokenData.tokens[0];
  const status = useMemo(() => getTokenLimitStatus(token, tokenData.usage), [token, tokenData.usage]);
  const limits = token?.limits || {};
  const [draftLimits, setDraftLimits] = useState(normalizeTokenLimits(limits));
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraftLimits(normalizeTokenLimits(token?.limits));
    setSaveError("");
    setSaveNotice("");
  }, [token?.id, token?.limits]);

  function updateLimit(field, value) {
    if (!token) {
      return;
    }

    setDraftLimits((current) => normalizeTokenLimits({
      ...current,
      [field]: value,
    }));
    setSaveNotice("");
  }

  async function saveLimits() {
    if (!token) {
      return;
    }

    setIsSaving(true);
    setSaveError("");
    setSaveNotice("");

    try {
      await onUpdateTokenLimits(token.id, draftLimits);
      setSaveNotice("Limits saved");
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="dashboard-section token-section">
      <div className="section-heading token-chart-heading">
        <div>
          <h2>Rate Limit Tracker</h2>
          <p className="side-note">Leave any limit at 0 for unlimited. Set a total quota only when the token needs a lifetime cap.</p>
        </div>
        <select value={token?.id || ""} onChange={(event) => onSelectedTokenId(event.target.value)}>
          {tokenData.tokens.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </div>

      {!token ? (
        <p className="side-note">Create a token to configure rate limits.</p>
      ) : (
        <>
          {saveError ? <div className="error-banner">{saveError}</div> : null}
          {saveNotice ? <div className="success-banner">{saveNotice}</div> : null}
          <div className="limit-grid">
            {status.checks.map((check) => (
              <LimitMeter
                key={check.key}
                label={check.label}
                limit={check.limit}
                missing={check.missing}
                used={check.used}
              />
            ))}
          </div>

          <div className="limit-editor">
            <label>
              Total token quota
              <input
                min="0"
                placeholder="Unlimited"
                type="number"
                value={draftLimits.totalTokens || ""}
                onChange={(event) => updateLimit("totalTokens", event.target.value)}
              />
            </label>
            <label>
              Requests / minute
              <input
                min="0"
                type="number"
                value={draftLimits.requestsPerMinute || 0}
                onChange={(event) => updateLimit("requestsPerMinute", event.target.value)}
              />
            </label>
            <label>
              Requests / hour
              <input
                min="0"
                type="number"
                value={draftLimits.requestsPerHour || 0}
                onChange={(event) => updateLimit("requestsPerHour", event.target.value)}
              />
            </label>
            <label>
              Requests / day
              <input
                min="0"
                type="number"
                value={draftLimits.requestsPerDay || 0}
                onChange={(event) => updateLimit("requestsPerDay", event.target.value)}
              />
            </label>
            <label>
              Tokens / day
              <input
                min="0"
                type="number"
                value={draftLimits.tokensPerDay || 0}
                onChange={(event) => updateLimit("tokensPerDay", event.target.value)}
              />
            </label>
            <div className="limit-actions">
              <button className="primary-button" disabled={isSaving} onClick={saveLimits} type="button">
                {isSaving ? "Saving..." : "Save limits"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function TokenRequestLog({events, tokens, selectedTokenId, onCopy, onSelectedTokenId, periodLabelText}) {
  const token = tokens.find((item) => item.id === selectedTokenId) || tokens[0];
  const rows = useMemo(
    () => [...events]
      .filter((entry) => entry.tokenId === token?.id)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, 50),
    [events, token?.id],
  );
  const summary = useMemo(() => tokenLogSummary(rows), [rows]);

  async function copyLogs() {
    const payload = rows.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      tokenId: entry.tokenId,
      tokenName: token?.name || "",
      status: entry.status,
      source: entry.source || "",
      historyKey: entry.historyKey || "",
      httpStatus: entry.httpStatus || "",
      errorType: entry.errorType || "",
      errorMessage: entry.errorMessage || "",
      failureStage: entry.failureStage || "",
      promptTokens: Number(entry.promptTokens || 0),
      responseTokens: Number(entry.responseTokens || 0),
      totalTokens: Number(entry.totalTokens || 0),
      latencyMs: Number(entry.latencyMs || 0),
      chatName: entry.chatName || "",
      chatTitle: entry.chatTitle || "",
      modelProvider: entry.modelProvider || "",
    }));

    await onCopy("Token logs", JSON.stringify(payload, null, 2));
  }

  return (
    <section className="dashboard-section token-section token-log-section" id="token-request-log">
      <div className="section-heading token-chart-heading">
        <div>
          <h2>Token Request Log</h2>
          <p className="side-note">{periodLabelText} · latest 50 entries for the selected token</p>
        </div>
        <div className="token-log-controls">
          <select value={token?.id || ""} onChange={(event) => onSelectedTokenId(event.target.value)}>
            {tokens.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <button className="small-button" disabled={!rows.length} onClick={copyLogs}>Copy logs</button>
        </div>
      </div>

      {!token ? (
        <p className="side-note">Create a token to view request logs.</p>
      ) : (
        <>
          <div className="token-log-summary" aria-label="Selected token log summary">
            <div>
              <span>Attempts</span>
              <strong>{summary.total}</strong>
            </div>
            <div>
              <span>Success</span>
              <strong>{summary.success}</strong>
            </div>
            <div>
              <span>Failed</span>
              <strong>{summary.failed}</strong>
            </div>
            <div>
              <span>Tokens</span>
              <strong>{summary.totalTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>Last seen</span>
              <strong>{summary.lastSeenAt ? formatChatTime(summary.lastSeenAt) : "No traffic"}</strong>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="side-note">No requests for {token.name} in this time window yet.</p>
          ) : (
            <div className="token-log-table">
              <div className="token-log-row token-log-header">
                <span>Time</span>
                <span>Status</span>
                <span>Source / History</span>
                <span>Usage</span>
                <span>Latency</span>
                <span>Detail</span>
              </div>
              {rows.map((entry) => (
                <div className={`token-log-row request-${entry.status}`} key={entry.id}>
                  <span>{formatChatTime(entry.createdAt)}</span>
                  <span>
                    <strong>{entry.status === "success" ? "Success" : "Failed"}</strong>
                    <small>{requestLogHttpStatus(entry)}</small>
                  </span>
                  <span>
                    <strong>{requestLogSource(entry)}</strong>
                    <small>{entry.modelProvider || "No provider recorded"}</small>
                  </span>
                  <span>
                    <strong>{Number(entry.totalTokens || 0).toLocaleString()} tokens</strong>
                    <small>{Number(entry.promptTokens || 0).toLocaleString()} in · {Number(entry.responseTokens || 0).toLocaleString()} out</small>
                  </span>
                  <span>{requestLogLatency(entry)}</span>
                  <span>{requestLogDetail(entry)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DashboardPage({account, onLogout, onNavigate}) {
  const [stores, setStores] = useState([]);
  const [chats, setChats] = useState([]);
  const [messagesByChat, setMessagesByChat] = useState({});
  const [periodDays, setPeriodDays] = useState(7);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  async function loadUsage() {
    setError("");
    setIsLoading(true);

    try {
      const [nextStores, nextChats] = await Promise.all([getStores(), getChats(account)]);
      const messageResults = await Promise.allSettled(nextChats.map((chat) => getMessages(chat)));
      const nextMessagesByChat = {};

      messageResults.forEach((result, index) => {
        nextMessagesByChat[nextChats[index].name] = result.status === "fulfilled" ? result.value : [];
      });

      setStores(nextStores);
      setChats(nextChats);
      setMessagesByChat(nextMessagesByChat);
    } catch (error) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function logout() {
    await signOut();
    onLogout();
  }

  useEffect(() => {
    loadUsage();
  }, [account]);

  const usage = useMemo(() => {
    const rangeStart = rangeStartForDays(periodDays);
    const allMessages = Object.values(messagesByChat).flat().filter((message) => dateInRange(message.createdTime, rangeStart));
    const userMessages = allMessages.filter((message) => message.author === account.name);
    const assistantMessages = allMessages.filter((message) => message.author === "AI");
    const storeNames = new Map(stores.map((store) => [store.name, store.displayName || store.name]));
    const chatRows = chats
      .map((item) => {
        const allChatMessages = messagesByChat[item.name] || [];
        const periodMessages = allChatMessages.filter((message) => dateInRange(message.createdTime, rangeStart));
        const wasUpdatedInRange = dateInRange(item.updatedTime || item.createdTime, rangeStart);

        return {
          ...item,
          actualMessageCount: periodMessages.length,
          hasPeriodActivity: periodMessages.length > 0 || wasUpdatedInRange,
        };
      })
      .filter((item) => item.hasPeriodActivity);
    const sortedChats = [...chatRows].sort((left, right) => {
      const leftTime = new Date(left.updatedTime || left.createdTime || 0).getTime();
      const rightTime = new Date(right.updatedTime || right.createdTime || 0).getTime();
      return rightTime - leftTime;
    });
    const lastActive = sortedChats[0]?.updatedTime || sortedChats[0]?.createdTime || account.lastSigninTime;
    const modelCounts = countBy(allMessages, (message) => message.modelProvider);
    const storeCounts = countBy(chatRows, (item) => storeNames.get(item.store) || item.store);

    return {
      allMessages,
      userMessages,
      assistantMessages,
      sortedChats,
      lastActive,
      rangeStart,
      promptWords: wordsIn(userMessages),
      answerWords: wordsIn(assistantMessages),
      modelEntries: topEntries(modelCounts),
      storeEntries: topEntries(storeCounts),
      dailyUsage: buildDailyUsage(allMessages, periodDays),
    };
  }, [account, chats, messagesByChat, periodDays, stores]);

  const selectedPeriodLabel = periodLabel(periodDays);

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/dashboard" onLogout={logout} onNavigate={onNavigate} />

      <section className="dashboard-layout">
        <div className="dashboard-title">
          <div>
            <p className="eyebrow">Signed in as {account.name}</p>
            <h2>Usage Dashboard</h2>
          </div>
          <div className="dashboard-actions">
            <label className="period-filter">
              Period
              <select
                disabled={isLoading}
                value={periodDays}
                onChange={(event) => setPeriodDays(Number(event.target.value))}
              >
                {dashboardPeriodOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={isLoading} onClick={loadUsage}>
              {isLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="stats-grid" aria-label="Usage totals">
          <StatCard label="Chats" value={usage.sortedChats.length} detail={`${usage.sortedChats.filter((chat) => chat.actualMessageCount > 0).length} with messages`} />
          <StatCard label="Messages" value={usage.allMessages.length} detail={selectedPeriodLabel} />
          <StatCard label="Prompts" value={usage.userMessages.length} detail={`${usage.promptWords} prompt words`} />
          <StatCard label="Answers" value={usage.assistantMessages.length} detail={`${usage.answerWords} answer words`} />
          <StatCard label="Last active" value={formatChatTime(usage.lastActive)} detail={`Login: ${formatFullTime(account.lastSigninTime)}`} />
          <StatCard label="Period" value={selectedPeriodLabel} detail={`Since ${shortDate(usage.rangeStart)}`} />
        </section>

        <div className="dashboard-grid">
          <DailyActivity days={usage.dailyUsage} title={`Last ${selectedPeriodLabel}`} />
          <UsageBreakdown title="Model Usage" entries={usage.modelEntries} />
          <UsageBreakdown title="Store Usage" entries={usage.storeEntries} />

          <section className="dashboard-section recent-section">
            <div className="section-heading">
              <h2>Recent Chats</h2>
            </div>
            {usage.sortedChats.length === 0 ? (
              <p className="side-note">No chats yet.</p>
            ) : (
              <div className="recent-table">
                {usage.sortedChats.slice(0, 8).map((item) => (
                  <div className="recent-row" key={item.name}>
                    <strong>{item.displayName || item.name}</strong>
                    <span>{item.actualMessageCount} messages</span>
                    <span>{formatChatTime(item.updatedTime || item.createdTime)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function dateValue(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function profileFormFrom(user) {
  return {
    displayName: user?.displayName || user?.name || "",
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    email: user?.email || "",
    phone: user?.phone || "",
    countryCode: user?.countryCode || "",
    region: user?.region || "",
    location: user?.location || "",
    title: user?.title || "",
    affiliation: user?.affiliation || "",
    homepage: user?.homepage || "",
    avatar: user?.avatar || "",
    bio: user?.bio || "",
    language: user?.language || "",
    gender: user?.gender || "",
    birthday: dateValue(user?.birthday),
    education: user?.education || "",
  };
}

function trimProfileForm(form) {
  return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, String(value || "").trim()]));
}

function ProfilePage({account, onAccountUpdated, onLogout, onNavigate}) {
  const [profile, setProfile] = useState(account);
  const [form, setForm] = useState(profileFormFrom(account));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");

  const cleanForm = useMemo(() => trimProfileForm(form), [form]);
  const originalForm = useMemo(() => profileFormFrom(profile), [profile]);
  const hasChanges = JSON.stringify(cleanForm) !== JSON.stringify(trimProfileForm(originalForm));
  const avatarUrl = cleanForm.avatar || profile?.permanentAvatar || "";

  function updateField(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
    setNotice("");
    if (field === "avatar") {
      setAvatarFailed(false);
    }
  }

  async function loadProfile() {
    setIsLoading(true);
    setError("");

    try {
      const nextProfile = await getUserProfile(account);
      setProfile(nextProfile);
      setForm(profileFormFrom(nextProfile));
      setAvatarFailed(false);
    } catch (error) {
      setProfile(account);
      setForm(profileFormFrom(account));
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function logout() {
    await signOut();
    onLogout();
  }

  async function submit(event) {
    event.preventDefault();

    if (!cleanForm.displayName) {
      setError("Display name is required.");
      setNotice("");
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    try {
      if (!hasCasdoorProfileToken(profile)) {
        if (!currentPassword) {
          setError("Enter your current password once to authorize profile updates.");
          setIsSaving(false);
          return;
        }

        await refreshCasdoorProfileToken(profile, currentPassword);
      }

      const updatedProfile = await updateUserProfile(profile, cleanForm);
      setProfile(updatedProfile);
      setForm(profileFormFrom(updatedProfile));
      onAccountUpdated({...account, ...updatedProfile});
      setCurrentPassword("");
      setNotice("Profile updated");
    } catch (error) {
      setError(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  function resetForm() {
    setForm(profileFormFrom(profile));
    setAvatarFailed(false);
    setError("");
    setNotice("");
  }

  useEffect(() => {
    loadProfile();
  }, [account]);

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/profile" onLogout={logout} onNavigate={onNavigate} />

      <section className="profile-layout">
        <aside className="profile-summary">
          <div className="profile-avatar">
            {avatarUrl && !avatarFailed ? (
              <img alt="" src={avatarUrl} onError={() => setAvatarFailed(true)} />
            ) : (
              <span>{initialsFor(profile)}</span>
            )}
          </div>
          <div>
            <h2>{displayName(profile)}</h2>
            <p className="muted">{profile?.title || profile?.affiliation || profile?.email || account.name}</p>
          </div>
          <div className="profile-facts">
            <div>
              <span>Username</span>
              <strong>{profile?.name || account.name}</strong>
            </div>
            <div>
              <span>Last sign in</span>
              <strong>{formatFullTime(profile?.lastSigninTime || account.lastSigninTime)}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{profile?.isForbidden ? "Forbidden" : "Active"}</strong>
            </div>
          </div>
        </aside>

        <form className="profile-form" onSubmit={submit}>
          <div className="profile-title">
            <div>
              <p className="eyebrow">Account settings</p>
              <h2>Profile</h2>
            </div>
            <div className="profile-actions">
              <button className="ghost-button" disabled={isLoading || isSaving} onClick={loadProfile} type="button">
                Refresh
              </button>
              <button className="ghost-button" disabled={isLoading || isSaving || !hasChanges} onClick={resetForm} type="button">
                Reset
              </button>
              <button className="primary-button" disabled={isLoading || isSaving || !hasChanges || !cleanForm.displayName}>
                {isSaving ? "Saving..." : "Save profile"}
              </button>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {notice ? <div className="success-banner">{notice}</div> : null}

          <section className="profile-card">
            <div className="section-heading">
              <h2>Identity</h2>
            </div>
            <div className="profile-grid">
              <label>
                Display name
                <input value={form.displayName} onChange={(event) => updateField("displayName", event.target.value)} required />
              </label>
              <label>
                First name
                <input value={form.firstName} onChange={(event) => updateField("firstName", event.target.value)} />
              </label>
              <label>
                Last name
                <input value={form.lastName} onChange={(event) => updateField("lastName", event.target.value)} />
              </label>
              <label>
                Avatar URL
                <input value={form.avatar} onChange={(event) => updateField("avatar", event.target.value)} placeholder="https://..." />
              </label>
            </div>
          </section>

          {!hasCasdoorProfileToken(profile) ? (
            <section className="profile-card profile-auth-card">
              <div>
                <h2>Confirm Access</h2>
                <p className="side-note">This session needs one password confirmation before Casdoor will accept profile changes.</p>
              </div>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
            </section>
          ) : null}

          <section className="profile-card">
            <div className="section-heading">
              <h2>Contact</h2>
            </div>
            <div className="profile-grid">
              <label>
                Email
                <input type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} />
              </label>
              <label>
                Country code
                <input value={form.countryCode} onChange={(event) => updateField("countryCode", event.target.value)} placeholder="+62" />
              </label>
              <label>
                Phone
                <input value={form.phone} onChange={(event) => updateField("phone", event.target.value)} />
              </label>
              <label>
                Homepage
                <input type="url" value={form.homepage} onChange={(event) => updateField("homepage", event.target.value)} placeholder="https://..." />
              </label>
            </div>
          </section>

          <section className="profile-card">
            <div className="section-heading">
              <h2>Work</h2>
            </div>
            <div className="profile-grid">
              <label>
                Title
                <input value={form.title} onChange={(event) => updateField("title", event.target.value)} />
              </label>
              <label>
                Affiliation
                <input value={form.affiliation} onChange={(event) => updateField("affiliation", event.target.value)} />
              </label>
              <label>
                Region
                <input value={form.region} onChange={(event) => updateField("region", event.target.value)} />
              </label>
              <label>
                Location
                <input value={form.location} onChange={(event) => updateField("location", event.target.value)} />
              </label>
            </div>
          </section>

          <section className="profile-card">
            <div className="section-heading">
              <h2>Preferences</h2>
            </div>
            <div className="profile-grid">
              <label>
                Language
                <input value={form.language} onChange={(event) => updateField("language", event.target.value)} placeholder="en" />
              </label>
              <label>
                Gender
                <select value={form.gender} onChange={(event) => updateField("gender", event.target.value)}>
                  <option value="">Not set</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label>
                Birthday
                <input type="date" value={form.birthday} onChange={(event) => updateField("birthday", event.target.value)} />
              </label>
              <label>
                Education
                <input value={form.education} onChange={(event) => updateField("education", event.target.value)} />
              </label>
            </div>
            <label>
              Bio
              <textarea value={form.bio} onChange={(event) => updateField("bio", event.target.value)} rows={4} />
            </label>
          </section>
        </form>
      </section>
    </main>
  );
}

function TokensPage({account, tokenData, onCreateToken, onToggleToken, onDeleteToken, onLogout, onNavigate}) {
  const [name, setName] = useState("");
  const [tokenLimit, setTokenLimit] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [periodDays, setPeriodDays] = useState(7);
  const [selectedSeriesTokenId, setSelectedSeriesTokenId] = useState("all");
  const [isMutatingToken, setIsMutatingToken] = useState(false);
  const periodRangeStart = useMemo(() => rangeStartForDays(periodDays), [periodDays]);
  const periodUsage = useMemo(() => tokenData.usage.filter((entry) => dateInRange(entry.createdAt, periodRangeStart)), [periodRangeStart, tokenData.usage]);
  const requestEvents = useMemo(() => buildTokenRequestEvents(tokenData), [tokenData]);
  const periodRequestEvents = useMemo(() => requestEvents.filter((entry) => dateInRange(entry.createdAt, periodRangeStart)), [periodRangeStart, requestEvents]);
  const periodTokenData = useMemo(() => ({...tokenData, usage: periodUsage}), [periodUsage, tokenData]);
  const summaries = useMemo(() => getTokenUsageSummary(periodTokenData), [periodTokenData]);
  const requestSummary = useMemo(() => summarizeRequestEvents(periodRequestEvents), [periodRequestEvents]);
  const requestByToken = useMemo(() => summarizeRequestsByToken(periodRequestEvents), [periodRequestEvents]);
  const seriesUsage = useMemo(() => {
    if (selectedSeriesTokenId === "all") {
      return periodUsage;
    }

    return periodUsage.filter((entry) => entry.tokenId === selectedSeriesTokenId);
  }, [periodUsage, selectedSeriesTokenId]);
  const seriesRequests = useMemo(() => {
    if (selectedSeriesTokenId === "all") {
      return periodRequestEvents;
    }

    return periodRequestEvents.filter((entry) => entry.tokenId === selectedSeriesTokenId);
  }, [periodRequestEvents, selectedSeriesTokenId]);
  const usageSeries = useMemo(() => buildTokenUsageSeries(seriesUsage, periodDays), [periodDays, seriesUsage]);
  const requestSeries = useMemo(() => buildTokenRequestSeries(seriesRequests, periodDays), [periodDays, seriesRequests]);
  const failedStatusChart = useMemo(() => buildFailedStatusSeries(seriesRequests, periodDays), [periodDays, seriesRequests]);
  const failures = useMemo(() => failureBreakdown(periodRequestEvents), [periodRequestEvents]);
  const recentUsage = useMemo(
    () => [...periodRequestEvents].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10),
    [periodRequestEvents],
  );
  const selectedPeriodLabel = periodLabel(periodDays);

  async function logout() {
    await signOut();
    onLogout();
  }

  async function copyToken(token) {
    await copyText(token.name, token.value);
  }

  async function copyText(label, text) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied`);
    } catch {
      setNotice("Copy failed");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const trimmedLimit = tokenLimit.trim();
    const totalTokens = trimmedLimit ? Math.floor(Number(trimmedLimit)) : 0;

    if (!Number.isFinite(totalTokens) || totalTokens < 0) {
      setFormError("Token quota must be 0 or greater.");
      setNotice("");
      return;
    }

    setIsMutatingToken(true);
    setFormError("");
    setNotice("");

    try {
      const token = await onCreateToken(name, {totalTokens});
      setName("");
      setTokenLimit("");
      setNotice(`${token.name} created`);
    } catch (error) {
      setFormError(error.message);
    } finally {
      setIsMutatingToken(false);
    }
  }

  async function deleteToken(token) {
    if (window.confirm(`Delete ${token.name}?`)) {
      setIsMutatingToken(true);
      setFormError("");
      setNotice("");

      try {
        await onDeleteToken(token.id);
        setNotice(`${token.name} deleted`);
      } catch (error) {
        setFormError(error.message);
      } finally {
        setIsMutatingToken(false);
      }
    }
  }

  async function toggleToken(token) {
    setIsMutatingToken(true);
    setFormError("");
    setNotice("");

    try {
      await onToggleToken(token.id);
    } catch (error) {
      setFormError(error.message);
    } finally {
      setIsMutatingToken(false);
    }
  }

  useEffect(() => {
    if (selectedSeriesTokenId !== "all" && !tokenData.tokens.some((token) => token.id === selectedSeriesTokenId)) {
      setSelectedSeriesTokenId("all");
    }
  }, [selectedSeriesTokenId, tokenData.tokens]);

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/tokens" onLogout={logout} onNavigate={onNavigate} />

      <section className="dashboard-layout">
        <div className="dashboard-title">
          <div>
            <p className="eyebrow">Signed in as {account.name}</p>
            <h2>Token Management</h2>
          </div>
          <div className="dashboard-actions token-management-actions">
            <label className="period-filter">
              Period
              <select
                value={periodDays}
                onChange={(event) => setPeriodDays(Number(event.target.value))}
              >
                {dashboardPeriodOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <form className="token-form" onSubmit={submit}>
              <input
                aria-label="Token name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Token name"
              />
              <input
                aria-label="Total token quota"
                inputMode="numeric"
                min="0"
                type="number"
                value={tokenLimit}
                onChange={(event) => setTokenLimit(event.target.value)}
                placeholder="Quota optional"
              />
              <button className="primary-button" disabled={isMutatingToken}>
                {isMutatingToken ? "Saving..." : "Create token"}
              </button>
            </form>
          </div>
        </div>

        {formError ? <div className="error-banner">{formError}</div> : null}
        {notice ? <div className="success-banner">{notice}</div> : null}

        <section className="stats-grid" aria-label="Token totals">
          <StatCard label="Tokens" value={tokenData.tokens.length} detail={`${tokenData.tokens.filter(isTokenActive).length} active`} />
          <StatCard label="Attempts" value={requestSummary.total} detail={`${selectedPeriodLabel} token requests`} />
          <StatCard label="Success rate" value={formatPercent(requestSummary.successRate)} detail={`${requestSummary.success} succeeded`} />
          <StatCard label="Failed" value={requestSummary.failed} detail={`${selectedPeriodLabel} failed requests`} />
          <StatCard label="Token usage" value={summaries.totals.totalTokens} detail={`${summaries.totals.promptTokens} prompt, ${summaries.totals.responseTokens} response`} />
          <StatCard label="Cost" value={summaries.totals.price.toFixed(4)} detail={`${selectedPeriodLabel}, reported by Casibase`} />
        </section>

        <TokenRequestMonitoring
          failureStatusLines={failedStatusChart.lines}
          failureStatusSeries={failedStatusChart.series}
          periodLabelText={selectedPeriodLabel}
          series={requestSeries}
        />

        <div className="token-insight-grid">
          <TokenUsageTimeseries
            periodLabelText={selectedPeriodLabel}
            selectedTokenId={selectedSeriesTokenId}
            series={usageSeries}
            tokens={tokenData.tokens}
            onSelectedTokenId={setSelectedSeriesTokenId}
          />

          <UsageBreakdown title="Failure Breakdown" entries={failures} />
        </div>

        <section className="dashboard-section token-section">
          <div className="section-heading">
            <h2>Tokens</h2>
          </div>
          {tokenData.tokens.length === 0 ? (
            <p className="side-note">No tokens yet.</p>
          ) : (
            <div className="token-table">
              {tokenData.tokens.map((token) => {
                const usage = summaries.byToken[token.id] || {};
                const requestStats = requestByToken[token.id] || {};

                return (
                  <article className="token-row" key={token.id}>
                    <div className="token-main">
                      <strong>{token.name}</strong>
                      <code>{maskToken(token.value)}</code>
                    </div>
                    <span className={`status-pill ${isTokenActive(token) ? "active" : "inactive"}`}>{token.status}</span>
                    <div className="token-usage">
                      <span>{requestStats.total || 0} attempts · {formatPercent(requestStats.successRate)}</span>
                      <span>{requestStats.failed || 0} failed · {requestStats.lastFailureReason || "No failures"}</span>
                      <span>{usage.totalTokens || 0} / {limitText(token.limits?.totalTokens || 0)} quota</span>
                      <span>{usage.lastUsedAt ? formatChatTime(usage.lastUsedAt) : `No use in ${selectedPeriodLabel}`}</span>
                    </div>
                    <div className="token-actions">
                      <button className="small-button" onClick={() => copyToken(token)}>Copy</button>
                      <button className="small-button" onClick={() => onNavigate(`/tokens/${token.id}`)}>Details</button>
                      <button className="small-button" disabled={isMutatingToken} onClick={() => toggleToken(token)}>
                        {isTokenActive(token) ? "Deactivate" : "Activate"}
                      </button>
                      <button className="small-button danger" disabled={isMutatingToken} onClick={() => deleteToken(token)}>Delete</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="dashboard-section token-section">
          <div className="section-heading">
            <h2>Recent Token Requests</h2>
            <p className="side-note">{selectedPeriodLabel}</p>
          </div>
          {recentUsage.length === 0 ? (
            <p className="side-note">No token requests in this time window yet.</p>
          ) : (
            <div className="recent-table">
              {recentUsage.map((entry) => {
                const token = tokenData.tokens.find((item) => item.id === entry.tokenId);

                return (
                  <div className={`recent-row token-usage-row request-${entry.status}`} key={entry.id}>
                    <strong>{token?.name || "Deleted token"}</strong>
                    <span>{entry.status === "success" ? "Success" : "Failed"}</span>
                    <span>{entry.status === "success" ? `${entry.totalTokens || 0} tokens` : (entry.errorMessage || entry.errorType || "Failed")}</span>
                    <span>{entry.chatTitle || entry.chatName || entry.failureStage || entry.source}</span>
                    <span>{formatChatTime(entry.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function TokenDetailPage({account, tokenId, tokenData, onToggleToken, onDeleteToken, onLogout, onNavigate, onUpdateTokenLimits}) {
  const [periodDays, setPeriodDays] = useState(7);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [isMutatingToken, setIsMutatingToken] = useState(false);
  const token = tokenData.tokens.find((item) => item.id === tokenId);
  const periodRangeStart = useMemo(() => rangeStartForDays(periodDays), [periodDays]);
  const requestEvents = useMemo(() => buildTokenRequestEvents(tokenData), [tokenData]);
  const periodRequestEvents = useMemo(() => requestEvents.filter((entry) => dateInRange(entry.createdAt, periodRangeStart)), [periodRangeStart, requestEvents]);
  const tokenRequestEvents = useMemo(() => periodRequestEvents.filter((entry) => entry.tokenId === token?.id), [periodRequestEvents, token?.id]);
  const tokenUsage = useMemo(
    () => tokenData.usage.filter((entry) => entry.tokenId === token?.id && dateInRange(entry.createdAt, periodRangeStart)),
    [periodRangeStart, token?.id, tokenData.usage],
  );
  const tokenOnlyData = useMemo(() => ({
    ...tokenData,
    tokens: token ? [token] : [],
    usage: tokenUsage,
  }), [token, tokenData, tokenUsage]);
  const summaries = useMemo(() => getTokenUsageSummary(tokenOnlyData), [tokenOnlyData]);
  const usage = token ? summaries.byToken[token.id] || {} : {};
  const requestSummary = useMemo(() => summarizeRequestEvents(tokenRequestEvents), [tokenRequestEvents]);
  const requestSeries = useMemo(() => buildTokenRequestSeries(tokenRequestEvents, periodDays), [periodDays, tokenRequestEvents]);
  const failedStatusChart = useMemo(() => buildFailedStatusSeries(tokenRequestEvents, periodDays), [periodDays, tokenRequestEvents]);
  const usageSeries = useMemo(() => buildTokenUsageSeries(tokenUsage, periodDays), [periodDays, tokenUsage]);
  const failures = useMemo(() => failureBreakdown(tokenRequestEvents), [tokenRequestEvents]);
  const selectedPeriodLabel = periodLabel(periodDays);

  async function logout() {
    await signOut();
    onLogout();
  }

  async function copyText(label, text) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied`);
      setError("");
    } catch {
      setError("Copy failed");
      setNotice("");
    }
  }

  async function copyToken() {
    if (token) {
      await copyText(token.name, token.value);
    }
  }

  async function toggleToken() {
    if (!token) {
      return;
    }

    setIsMutatingToken(true);
    setError("");
    setNotice("");

    try {
      await onToggleToken(token.id);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsMutatingToken(false);
    }
  }

  async function deleteToken() {
    if (!token || !window.confirm(`Delete ${token.name}?`)) {
      return;
    }

    setIsMutatingToken(true);
    setError("");
    setNotice("");

    try {
      await onDeleteToken(token.id);
      onNavigate("/tokens");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setIsMutatingToken(false);
    }
  }

  function selectToken(nextTokenId) {
    if (nextTokenId === "all") {
      onNavigate("/tokens");
      return;
    }

    onNavigate(`/tokens/${nextTokenId}`);
  }

  if (!token) {
    return (
      <main className="chat-shell">
        <AppHeader account={account} currentPath="/tokens" onLogout={logout} onNavigate={onNavigate} />
        <section className="dashboard-layout">
          <section className="empty-state">
            <h2>Token not found</h2>
            <p className="side-note">This token may have been deleted or belongs to another signed-in account.</p>
            <button className="primary-button" onClick={() => onNavigate("/tokens")}>Back to tokens</button>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/tokens" onLogout={logout} onNavigate={onNavigate} />

      <section className="dashboard-layout">
        <div className="dashboard-title">
          <div>
            <p className="eyebrow">Token detail</p>
            <h2>{token.name}</h2>
          </div>
          <div className="dashboard-actions">
            <label className="period-filter">
              Period
              <select
                value={periodDays}
                onChange={(event) => setPeriodDays(Number(event.target.value))}
              >
                {dashboardPeriodOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <button className="ghost-button" onClick={() => onNavigate("/tokens")}>Back to tokens</button>
            <button className="ghost-button" onClick={copyToken}>Copy token</button>
            <button className="ghost-button" disabled={isMutatingToken} onClick={toggleToken}>
              {isTokenActive(token) ? "Deactivate" : "Activate"}
            </button>
            <button className="small-button danger" disabled={isMutatingToken} onClick={deleteToken}>Delete</button>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {notice ? <div className="success-banner">{notice}</div> : null}

        <section className="dashboard-section token-section token-detail-overview">
          <div className="token-detail-main">
            <div>
              <span>Token</span>
              <code>{maskToken(token.value)}</code>
            </div>
            <div>
              <span>Status</span>
              <strong>{token.status}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{formatFullTime(token.createdAt)}</strong>
            </div>
            <div>
              <span>Last used</span>
              <strong>{formatFullTime(usage.lastUsedAt || token.lastUsedAt)}</strong>
            </div>
            <div>
              <span>Total quota</span>
              <strong>{limitText(token.limits?.totalTokens || 0)}</strong>
            </div>
          </div>
        </section>

        <section className="stats-grid" aria-label="Selected token totals">
          <StatCard label="Attempts" value={requestSummary.total} detail={`${selectedPeriodLabel} token requests`} />
          <StatCard label="Success rate" value={formatPercent(requestSummary.successRate)} detail={`${requestSummary.success} succeeded`} />
          <StatCard label="Failed" value={requestSummary.failed} detail={`${selectedPeriodLabel} failed requests`} />
          <StatCard label="Token usage" value={usage.totalTokens || 0} detail={`${usage.promptTokens || 0} prompt, ${usage.responseTokens || 0} response`} />
          <StatCard label="Quota" value={`${usage.totalTokens || 0} / ${limitText(token.limits?.totalTokens || 0)}`} detail="Lifetime token quota" />
          <StatCard label="Cost" value={(usage.price || 0).toFixed(4)} detail={`${selectedPeriodLabel}, reported by Casibase`} />
        </section>

        <TokenRequestMonitoring
          failureStatusLines={failedStatusChart.lines}
          failureStatusSeries={failedStatusChart.series}
          periodLabelText={selectedPeriodLabel}
          series={requestSeries}
        />

        <div className="token-insight-grid">
          <TokenUsageTimeseries
            periodLabelText={selectedPeriodLabel}
            selectedTokenId={token.id}
            series={usageSeries}
            tokens={tokenData.tokens}
            onSelectedTokenId={selectToken}
          />

          <UsageBreakdown title="Failure Breakdown" entries={failures} />
        </div>

        <RateLimitTracker
          selectedTokenId={token.id}
          tokenData={tokenData}
          onSelectedTokenId={selectToken}
          onUpdateTokenLimits={onUpdateTokenLimits}
        />

        <ApiReference token={token} onCopy={copyText} />

        <TokenRequestLog
          events={periodRequestEvents}
          periodLabelText={selectedPeriodLabel}
          selectedTokenId={token.id}
          tokens={tokenData.tokens}
          onCopy={copyText}
          onSelectedTokenId={selectToken}
        />
      </section>
    </main>
  );
}

function ChatHistory({
  chats,
  activeChatName,
  deletingChatName,
  isLoading,
  isSending,
  renamingChatName,
  onDeleteChat,
  onNewChat,
  onOpenChat,
  onRenameChat,
  onRefresh,
}) {
  const isDeleting = Boolean(deletingChatName);
  const isRenaming = Boolean(renamingChatName);
  const isBusy = isSending || isDeleting || isRenaming;
  const [editingChatName, setEditingChatName] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  function startRename(item) {
    setEditingChatName(item.name);
    setDraftTitle(item.displayName || item.name);
  }

  function cancelRename() {
    setEditingChatName("");
    setDraftTitle("");
  }

  async function submitRename(event, item) {
    event.preventDefault();

    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      return;
    }

    if (nextTitle === (item.displayName || item.name)) {
      cancelRename();
      return;
    }

    const saved = await onRenameChat(item, nextTitle);
    if (saved) {
      cancelRename();
    }
  }

  return (
    <section className="history-section" aria-label="Chat history">
      <button className="new-chat-button" disabled={isBusy} onClick={onNewChat} type="button">
        <span>+</span>
        <strong>New chat</strong>
      </button>

      <div className="section-heading">
        <h2>Conversations</h2>
        <button className="small-button" disabled={isLoading || isBusy} onClick={onRefresh}>Refresh</button>
      </div>

      {isLoading ? (
        <p className="side-note">Loading chats...</p>
      ) : chats.length === 0 ? (
        <p className="side-note">No chat history yet.</p>
      ) : (
        <div className="history-list">
          {chats.map((item) => {
            const isEditing = editingChatName === item.name;

            return (
              <div
                className={`history-row ${item.name === activeChatName ? "active" : ""} ${isEditing ? "editing" : ""}`}
                key={item.name}
              >
                {isEditing ? (
                  <form className="history-rename-form" onSubmit={(event) => submitRename(event, item)}>
                    <input
                      aria-label="Chat name"
                      autoFocus
                      disabled={renamingChatName === item.name}
                      maxLength={80}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          cancelRename();
                        }
                      }}
                      value={draftTitle}
                    />
                    <div className="history-rename-actions">
                      <button className="small-button" disabled={!draftTitle.trim() || renamingChatName === item.name} type="submit">
                        {renamingChatName === item.name ? "Saving..." : "Save"}
                      </button>
                      <button className="small-button" disabled={renamingChatName === item.name} onClick={cancelRename} type="button">
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button
                      className="history-item"
                      disabled={isBusy}
                      onClick={() => onOpenChat(item)}
                      type="button"
                    >
                      <span className="history-title">{item.displayName || item.name}</span>
                      <span className="history-meta">
                        <span>{item.messageCount || 0} messages</span>
                        {item.updatedTime ? <span>{formatChatTime(item.updatedTime)}</span> : null}
                      </span>
                    </button>
                    <button
                      aria-label={`Rename ${item.displayName || item.name}`}
                      className="history-action-button history-rename-button"
                      disabled={isBusy}
                      onClick={() => startRename(item)}
                      title="Rename chat"
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      aria-label={`Delete ${item.displayName || item.name}`}
                      className="history-action-button history-delete-button"
                      disabled={isBusy}
                      onClick={() => onDeleteChat(item)}
                      title="Delete chat"
                      type="button"
                    >
                      {deletingChatName === item.name ? "..." : "Delete"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MessageList({messages, account, streamingText, reasonText}) {
  const items = useMemo(() => {
    if (!streamingText) {
      return messages;
    }

    const next = [...messages];
    const index = next.findLastIndex((message) => message.author === "AI");
    if (index >= 0) {
      next[index] = {...next[index], text: streamingText};
      return next;
    }

    return next;
  }, [messages, streamingText]);

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <h2>Ready for a message</h2>
        <p>Choose a store and send a prompt. The response streams from Casibase through Server-Sent Events.</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {items.map((message) => (
        <article className={`message ${roleOf(message, account)}`} key={message.name}>
          <div className="message-meta">
            <span>{message.author === "AI" ? "Casibase" : displayName(account)}</span>
            <span>{message.modelProvider || ""}</span>
          </div>
          {message.fileName ? (
            <div className="message-files">
              <span>Attachment</span>
              <strong>{message.fileName}</strong>
            </div>
          ) : null}
          <p>{message.text || (message.author === "AI" ? "Thinking..." : "")}</p>
        </article>
      ))}
      {reasonText ? (
        <article className="message reason">
          <div className="message-meta">
            <span>Reasoning</span>
          </div>
          <p>{reasonText}</p>
        </article>
      ) : null}
    </div>
  );
}

function ChatPage({account, onCheckTokenLimit, onLogout, onNavigate, tokenData, onRecordTokenRequest, onRecordTokenUsage}) {
  const [stores, setStores] = useState([]);
  const [chats, setChats] = useState([]);
  const [storeName, setStoreName] = useState("");
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [isLoadingStores, setIsLoadingStores] = useState(true);
  const [isLoadingChats, setIsLoadingChats] = useState(true);
  const [deletingChatName, setDeletingChatName] = useState("");
  const [renamingChatName, setRenamingChatName] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const closeStreamRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const streamStateRef = useRef(null);

  const selectedStore = stores.find((store) => store.name === storeName) || chooseStore(stores);
  const activeTokens = tokenData.tokens.filter(isTokenActive);
  const selectedToken = activeTokens.find((token) => token.id === selectedTokenId);

  async function loadChats() {
    setIsLoadingChats(true);

    try {
      const nextChats = await getChats(account);
      setChats(nextChats);
      return nextChats;
    } catch (error) {
      setError(error.message);
      return [];
    } finally {
      setIsLoadingChats(false);
    }
  }

  useEffect(() => {
    let active = true;

    getStores()
      .then((nextStores) => {
        if (!active) {
          return;
        }

        setStores(nextStores);
        setStoreName(chooseStore(nextStores)?.name || "");
      })
      .catch((error) => setError(error.message))
      .finally(() => {
        if (active) {
          setIsLoadingStores(false);
        }
      });

    return () => {
      active = false;
      closeStreamRef.current?.();
    };
  }, []);

  useEffect(() => {
    let active = true;

    setIsLoadingChats(true);
    getChats(account)
      .then((nextChats) => {
        if (active) {
          setChats(nextChats);
        }
      })
      .catch((error) => {
        if (active) {
          setError(error.message);
        }
      })
      .finally(() => {
        if (active) {
          setIsLoadingChats(false);
        }
      });

    return () => {
      active = false;
    };
  }, [account]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({block: "end"});
  }, [messages, streamingText, reasonText]);

  useEffect(() => {
    setSelectedTokenId((current) => {
      if (activeTokens.some((token) => token.id === current)) {
        return current;
      }

      return activeTokens[0]?.id || "";
    });
  }, [tokenData.tokens]);

  function updateAttachment(id, updates) {
    setPendingAttachments((current) => current.map((item) => item.id === id ? {...item, ...updates} : item));
  }

  async function handleAttachmentChange(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (!files.length) {
      return;
    }

    const acceptedFiles = files.filter(isImageFile);
    const rejectedFiles = files.filter((file) => !isImageFile(file));

    if (rejectedFiles.length) {
      setError(`Only image files can be attached. Skipped: ${rejectedFiles.map((file) => file.name).join(", ")}`);
    } else {
      setError("");
    }

    if (!acceptedFiles.length) {
      return;
    }

    const nextAttachments = acceptedFiles.map((file) => ({
      id: attachmentId(file),
      file,
      name: file.name,
      size: file.size,
      status: "Ready",
      type: file.type || "",
      imageStatus: "Image ready",
    }));

    setPendingAttachments((current) => [...current, ...nextAttachments]);
  }

  function removeAttachment(id) {
    setPendingAttachments((current) => current.filter((item) => item.id !== id));
  }

  async function uploadPendingAttachments(items, activeChat) {
    if (!items.length) {
      return [];
    }

    const key = `d-ai/${account.name}/${activeChat.name}`;
    const uploaded = [];

    for (const item of items) {
      if (item.objectKey) {
        uploaded.push({
          filename: item.name,
          objectKey: item.objectKey,
          size: item.size,
          type: item.file?.type || "",
          record: item.record,
          id: item.id,
        });
        continue;
      }

      updateAttachment(item.id, {status: "Uploading", error: ""});

      try {
        const upload = await uploadStoreFile({store: selectedStore, file: item.file, key});
        const attachment = {
          ...upload,
          id: item.id,
        };
        uploaded.push(attachment);
        updateAttachment(item.id, {
          status: "Uploaded",
          objectKey: upload.objectKey,
          record: upload.record,
        });
      } catch (error) {
        updateAttachment(item.id, {status: "Failed", error: error.message});
        throw new Error(`Failed to upload ${item.name}: ${error.message}`);
      }
    }

    return uploaded;
  }

  async function newChat() {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    setChat(null);
    setMessages([]);
    setStreamingText("");
    setReasonText("");
    setPendingAttachments([]);
    setError("");
  }

  async function openChat(nextChat) {
    if (!nextChat || isSending) {
      return;
    }

    closeStreamRef.current?.();
    closeStreamRef.current = null;
    setError("");
    setStreamingText("");
    setReasonText("");
    setPendingAttachments([]);
    setChat(nextChat);
    if (nextChat.store && stores.some((store) => store.name === nextChat.store)) {
      setStoreName(nextChat.store);
    } else {
      setStoreName(chooseStore(stores)?.name || "");
    }

    try {
      setMessages(await getMessages(nextChat));
    } catch (error) {
      setError(error.message);
    }
  }

  function replaceMessageByName(items, nextMessage) {
    if (items.some((item) => item.name === nextMessage.name)) {
      return items.map((item) => item.name === nextMessage.name ? nextMessage : item);
    }

    return [...items, nextMessage];
  }

  async function interruptStream({savePartial = true} = {}) {
    const streamState = streamStateRef.current;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    streamStateRef.current = null;
    setIsSending(false);
    setStreamingText("");
    setReasonText("");

    if (!savePartial || !streamState?.answer) {
      return;
    }

    const answerText = (streamState.answerText || "").trimEnd();
    const interruptedAnswer = {
      ...streamState.answer,
      text: answerText || "Response interrupted.",
      reasonText: (streamState.reasonText || "").trimEnd(),
      errorText: answerText ? "" : "Interrupted by user",
      isAlerted: false,
    };
    let usageMessages = replaceMessageByName(messages, interruptedAnswer);

    setMessages(usageMessages);

    try {
      await updateMessage(interruptedAnswer);
      usageMessages = await getMessages(streamState.chat);
      setMessages(usageMessages);
      await loadChats();
    } catch (error) {
      setError(`Stream stopped, but failed to save the partial answer: ${error.message}`);
    }

    if (streamState.usageToken) {
      onRecordTokenUsage(createUsageRecord({
        tokenId: streamState.usageToken.id,
        chat: streamState.chat,
        messages: usageMessages,
        answerName: interruptedAnswer.name,
        promptText: streamState.promptText,
      }));
    }
  }

  async function removeChat(nextChat) {
    if (!nextChat || isSending || deletingChatName) {
      return;
    }

    const title = nextChat.displayName || nextChat.name;
    if (!window.confirm(`Delete "${title}" and its messages?`)) {
      return;
    }

    setDeletingChatName(nextChat.name);
    setError("");

    try {
      await deleteChat(nextChat);
      setChats((current) => current.filter((item) => item.name !== nextChat.name));

      if (chat?.name === nextChat.name) {
        closeStreamRef.current?.();
        closeStreamRef.current = null;
        setChat(null);
        setMessages([]);
        setStreamingText("");
        setReasonText("");
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setDeletingChatName("");
    }
  }

  async function renameChat(nextChat, displayName) {
    if (!nextChat || isSending || deletingChatName || renamingChatName) {
      return false;
    }

    const nextDisplayName = displayName.trim();
    if (!nextDisplayName) {
      return false;
    }

    const updatedChat = {
      ...nextChat,
      displayName: nextDisplayName,
    };

    setRenamingChatName(nextChat.name);
    setError("");

    try {
      await updateChat(updatedChat);
      setChats((current) => current.map((item) => item.name === nextChat.name ? {...item, displayName: nextDisplayName} : item));
      setChat((current) => current?.name === nextChat.name ? {...current, displayName: nextDisplayName} : current);
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    } finally {
      setRenamingChatName("");
    }
  }

  async function logout() {
    closeStreamRef.current?.();
    await signOut();
    onLogout();
  }

  async function sendPrompt(text, attachmentsToUpload = []) {
    setIsSending(true);
    setStreamingText("");
    setReasonText("");
    const requestStartedAt = Date.now();

    try {
      const usageToken = selectedToken;
      const activeChat = chat || await createChat({account, store: selectedStore});
      setChat(activeChat);
      const uploadedAttachments = await uploadPendingAttachments(attachmentsToUpload, activeChat);
      const modelText = buildAttachmentPrompt(text, uploadedAttachments);
      const messageFileName = uploadedAttachments
        .map((item) => item.filename)
        .filter(Boolean)
        .join(", ");

      setMessages((current) => [
        ...current,
        {
          owner: "admin",
          name: `local_${Date.now()}`,
          author: account.name,
          text: modelText,
          fileName: messageFileName,
          modelProvider: selectedStore?.modelProvider || "",
        },
      ]);

      const updatedChat = await sendChatMessage({
        account,
        chat: activeChat,
        store: selectedStore,
        text: modelText,
        attachments: uploadedAttachments,
      });
      setChat(updatedChat);
      setPendingAttachments((current) => current.filter((item) => !attachmentsToUpload.some((attachment) => attachment.id === item.id)));
      setChats((current) => {
        const next = current.filter((item) => item.name !== updatedChat.name);
        return [updatedChat, ...next];
      });

      const nextMessages = await getMessages(updatedChat);
      setMessages(nextMessages);

      const answer = [...nextMessages].reverse().find((message) => message.author === "AI" && message.replyTo !== "");
      if (!answer) {
        if (usageToken) {
          onRecordTokenUsage(createUsageRecord({
            tokenId: usageToken.id,
            chat: updatedChat,
            messages: nextMessages,
            promptText: modelText,
          }));
        }
        setIsSending(false);
        return;
      }

      let answerText = answer.text || "";
      streamStateRef.current = {
        answer,
        answerText,
        chat: updatedChat,
        promptText: modelText,
        reasonText: "",
        usageToken,
      };
      setStreamingText(answerText);
      closeStreamRef.current = openAnswerStream({
        message: answer,
        onText: (chunk) => {
          if (streamStateRef.current?.answer.name !== answer.name) {
            return;
          }

          answerText += chunk || "\n";
          streamStateRef.current.answerText = answerText;
          setStreamingText(answerText);
        },
        onReason: (chunk) => {
          if (streamStateRef.current?.answer.name !== answer.name) {
            return;
          }

          if (chunk) {
            streamStateRef.current.reasonText += chunk;
            setReasonText((current) => current + chunk);
          }
        },
        onEnd: async () => {
          if (streamStateRef.current?.answer.name !== answer.name) {
            return;
          }

          streamStateRef.current = null;
          closeStreamRef.current = null;
          setIsSending(false);
          setStreamingText("");
          setReasonText("");
          try {
            const finalMessages = await getMessages(updatedChat);
            setMessages(finalMessages);
            if (usageToken) {
              onRecordTokenUsage(createUsageRecord({
                tokenId: usageToken.id,
                chat: updatedChat,
                messages: finalMessages,
                answerName: answer.name,
                promptText: modelText,
              }));
            }
            await loadChats();
          } catch (error) {
            setError(error.message);
          }
        },
        onError: (error) => {
          if (streamStateRef.current?.answer.name !== answer.name) {
            return;
          }

          if (usageToken) {
            onRecordTokenRequest({
              tokenId: usageToken.id,
              createdAt: new Date().toISOString(),
              status: "failed",
              source: "chat",
              httpStatus: 500,
              errorType: "stream_error",
              errorMessage: error.message,
              failureStage: "stream",
              promptTokens: estimateTokenCount(modelText),
              responseTokens: 0,
              totalTokens: estimateTokenCount(modelText),
              latencyMs: Date.now() - requestStartedAt,
              chatName: updatedChat.name,
              chatTitle: updatedChat.displayName || updatedChat.name,
              modelProvider: updatedChat.modelProvider || selectedStore?.modelProvider || "",
            });
          }

          streamStateRef.current = null;
          closeStreamRef.current = null;
          setError(error.message);
          setIsSending(false);
          setStreamingText("");
          setReasonText("");
        },
      });
    } catch (error) {
      streamStateRef.current = null;
      if (selectedToken) {
        onRecordTokenRequest({
          tokenId: selectedToken.id,
          createdAt: new Date().toISOString(),
          status: "failed",
          source: "chat",
          httpStatus: 500,
          errorType: "client_error",
          errorMessage: error.message,
          failureStage: "client",
          promptTokens: estimateTokenCount(text),
          responseTokens: 0,
          totalTokens: estimateTokenCount(text),
          latencyMs: Date.now() - requestStartedAt,
          chatName: chat?.name || "",
          chatTitle: chat?.displayName || chat?.name || "",
          modelProvider: selectedStore?.modelProvider || "",
        });
      }
      setError(error.message);
      setIsSending(false);
      setStreamingText("");
      setReasonText("");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const attachmentsToUpload = pendingAttachments.filter((item) => item.file && item.status !== "Uploading");
    const text = input.trim() || (attachmentsToUpload.length ? "Please analyze the attached image." : "");

    if (!text) {
      return;
    }

    if (isSending && attachmentsToUpload.length) {
      setError("Finish or stop the current stream before sending attachments.");
      return;
    }

    if (selectedToken) {
      try {
        await onCheckTokenLimit(selectedToken.id, text);
      } catch (error) {
        const prefix = error.message.toLowerCase().includes("limit") ? "Token limit exceeded: " : "";
        setError(`${prefix}${error.message}`);
        return;
      }
    }

    setInput("");
    setError("");

    if (isSending) {
      await interruptStream();
    }

    await sendPrompt(text, attachmentsToUpload);
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      submit(event);
    }
  }

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/" onLogout={logout} onNavigate={onNavigate} />

      <section className="chat-layout">
        <aside className="side-panel">
          <label>
            Store
            <select
              disabled={isLoadingStores || isSending}
              value={storeName}
              onChange={(event) => setStoreName(event.target.value)}
            >
              {stores.map((store) => (
                <option key={store.name} value={store.name}>
                  {store.displayName || store.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            API token
            <select
              disabled={isSending}
              value={selectedTokenId}
              onChange={(event) => setSelectedTokenId(event.target.value)}
            >
              <option value="">No token</option>
              {activeTokens.map((token) => (
                <option key={token.id} value={token.id}>
                  {token.name}
                </option>
              ))}
            </select>
          </label>
          <div className="detail-list">
            <div>
              <span>Model</span>
              <strong>{selectedStore?.modelProvider || "No provider"}</strong>
            </div>
            <div>
              <span>Chat</span>
              <strong>{chat?.displayName || "Not started"}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{isSending ? "Streaming" : "Idle"}</strong>
            </div>
            <div>
              <span>Token</span>
              <strong>{selectedToken?.name || "No token"}</strong>
            </div>
          </div>

          <ChatHistory
            activeChatName={chat?.name}
            chats={chats}
            deletingChatName={deletingChatName}
            isLoading={isLoadingChats}
            isSending={isSending}
            onDeleteChat={removeChat}
            onNewChat={newChat}
            onOpenChat={openChat}
            onRenameChat={renameChat}
            onRefresh={loadChats}
            renamingChatName={renamingChatName}
          />
        </aside>

        <section className="conversation" aria-live="polite">
          <MessageList messages={messages} account={account} streamingText={streamingText} reasonText={reasonText} />
          <div ref={messagesEndRef} />
        </section>

        <form className="composer" onSubmit={submit}>
          {error ? <div className="error-banner">{error}</div> : null}
          <input
            ref={fileInputRef}
            className="sr-only-file"
            disabled={isLoadingStores || !selectedStore || isSending}
            accept="image/*"
            multiple
            onChange={handleAttachmentChange}
            type="file"
          />
          {pendingAttachments.length ? (
            <div className="attachment-tray">
              {pendingAttachments.map((item) => (
                <div className={`attachment-pill ${item.error ? "error" : ""}`} key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{formatFileSize(item.size)} · {item.status} · {item.imageStatus}</span>
                    {item.error ? <span>{item.error}</span> : null}
                  </div>
                  <button
                    className="small-button"
                    disabled={item.status === "Uploading" || isSending}
                    onClick={() => removeAttachment(item.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={isSending ? "Steer the current response" : "Send a message to Casibase"}
            disabled={isLoadingStores || !selectedStore}
            rows={3}
          />
          <div className="composer-actions">
            <button
              className="ghost-button attach-button"
              disabled={isLoadingStores || !selectedStore || isSending}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              Attach image
            </button>
            {isSending ? (
              <button className="ghost-button stop-button" onClick={() => interruptStream()} type="button">
                Stop
              </button>
            ) : null}
            <button className="primary-button" disabled={isLoadingStores || !selectedStore || (!input.trim() && !pendingAttachments.length)}>
              {isSending ? "Steer" : "Send"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [isChecking, setIsChecking] = useState(true);
  const [path, setPath] = useState(window.location.pathname);
  const [tokenData, setTokenData] = useState(emptyTokenState());

  function navigate(nextPath) {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }

  function applyTokenState(next) {
    const state = {
      ...emptyTokenState(),
      ...next,
      tokens: Array.isArray(next?.tokens) ? next.tokens : [],
      usage: Array.isArray(next?.usage) ? next.usage : [],
      requestEvents: Array.isArray(next?.requestEvents) ? next.requestEvents : [],
    };

    saveTokenState(account, state);
    setTokenData(state);
    return state;
  }

  function persistTokenData(next) {
    saveTokenState(account, next);

    if (!account) {
      return;
    }

    syncTokenState(account, next)
      .then((synced) => {
        saveTokenState(account, synced);
        setTokenData(synced);
      })
      .catch(() => null);
  }

  function applyTokenMutation(result) {
    if (result?.state) {
      applyTokenState(result.state);
    }

    return result;
  }

  async function createManagedToken(name, limits) {
    const result = applyTokenMutation(await mutateTokenState("create-token", {name, limits}));
    return result.token;
  }

  async function toggleManagedToken(tokenId) {
    applyTokenMutation(await mutateTokenState("toggle-token", {tokenId}));
  }

  async function updateManagedTokenLimits(tokenId, limits) {
    applyTokenMutation(await mutateTokenState("update-token-limits", {tokenId, limits: normalizeTokenLimits(limits)}));
  }

  async function deleteManagedToken(tokenId) {
    applyTokenMutation(await mutateTokenState("delete-token", {tokenId}));
  }

  function recordManagedTokenUsage(entry) {
    mutateTokenState("record-usage", {entry})
      .then(applyTokenMutation)
      .catch(() => persistTokenData({
        ...tokenData,
        tokens: tokenData.tokens.map((token) => token.id === entry.tokenId ? {...token, lastUsedAt: entry.createdAt} : token),
        usage: [entry, ...tokenData.usage].slice(0, 500),
        requestEvents: [
          {
            id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            tokenId: entry.tokenId,
            createdAt: entry.createdAt,
            status: "success",
            source: "chat",
            httpStatus: 200,
            errorType: "",
            errorMessage: "",
            failureStage: "",
            promptTokens: entry.promptTokens || 0,
            responseTokens: entry.responseTokens || 0,
            totalTokens: entry.totalTokens || 0,
            latencyMs: 0,
            chatName: entry.chatName || "",
            chatTitle: entry.chatTitle || "",
            modelProvider: "",
            usageId: entry.id,
          },
          ...(tokenData.requestEvents || []),
        ].slice(0, 1000),
      }));
  }

  function recordManagedTokenRequest(event) {
    mutateTokenState("record-request", {event})
      .then(applyTokenMutation)
      .catch(() => persistTokenData({
        ...tokenData,
        requestEvents: [
          {
            id: event.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            createdAt: event.createdAt || new Date().toISOString(),
            status: event.status || "failed",
            ...event,
          },
          ...(tokenData.requestEvents || []),
        ].slice(0, 1000),
      }));
  }

  async function checkManagedTokenLimit(tokenId, promptText) {
    const result = await checkTokenLimit({
      tokenId,
      promptText,
      pendingTokens: estimateTokenCount(promptText),
    });

    applyTokenMutation(result);
    return result;
  }

  useEffect(() => {
    getAccount()
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setIsChecking(false));
  }, []);

  useEffect(() => {
    function handlePopState() {
      setPath(window.location.pathname);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!account) {
      setTokenData(emptyTokenState());
      return;
    }

    const next = loadTokenState(account);
    setTokenData(next);
    syncTokenState(account, next)
      .then((synced) => {
        applyTokenState(synced);
      })
      .catch(() => getServerTokenState()
        .then(applyTokenState)
        .catch(() => null));
  }, [account]);

  if (isChecking) {
    return (
      <main className="loading-shell">
        <div className="loader" />
        <p>Checking session...</p>
      </main>
    );
  }

  if (!account) {
    return <LoginPage onLogin={setAccount} />;
  }

  if (path === "/dashboard") {
    return <DashboardPage account={account} onLogout={() => setAccount(null)} onNavigate={navigate} />;
  }

  if (path === "/tokens") {
    return (
      <TokensPage
        account={account}
        tokenData={tokenData}
        onCreateToken={createManagedToken}
        onDeleteToken={deleteManagedToken}
        onLogout={() => setAccount(null)}
        onNavigate={navigate}
        onToggleToken={toggleManagedToken}
      />
    );
  }

  if (path.startsWith("/tokens/")) {
    const tokenId = decodeURIComponent(path.slice("/tokens/".length));

    return (
      <TokenDetailPage
        account={account}
        tokenData={tokenData}
        tokenId={tokenId}
        onDeleteToken={deleteManagedToken}
        onLogout={() => setAccount(null)}
        onNavigate={navigate}
        onToggleToken={toggleManagedToken}
        onUpdateTokenLimits={updateManagedTokenLimits}
      />
    );
  }

  if (path === "/profile") {
    return (
      <ProfilePage
        account={account}
        onAccountUpdated={setAccount}
        onLogout={() => setAccount(null)}
        onNavigate={navigate}
      />
    );
  }

  return (
    <ChatPage
      account={account}
      onCheckTokenLimit={checkManagedTokenLimit}
      onLogout={() => setAccount(null)}
      onNavigate={navigate}
      onRecordTokenRequest={recordManagedTokenRequest}
      onRecordTokenUsage={recordManagedTokenUsage}
      tokenData={tokenData}
    />
  );
}
