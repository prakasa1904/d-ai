import {useEffect, useMemo, useRef, useState} from "react";
import {
  chooseStore,
  createChat,
  deleteChat,
  getAccount,
  getChats,
  getMessages,
  getStores,
  loginWithPassword,
  openAnswerStream,
  registerWithPassword,
  sendChatMessage,
  signOut,
  syncTokenState,
  updateChat,
  updateMessage,
  getUserProfile,
  hasCasdoorProfileToken,
  refreshCasdoorProfileToken,
  updateUserProfile,
} from "./api";
import {
  createTokenRecord,
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

function buildDailyUsage(messages) {
  const days = [];
  const today = startOfToday();

  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    days.push({
      key: day.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat(undefined, {weekday: "short"}).format(day),
      count: 0,
    });
  }

  const index = new Map(days.map((day) => [day.key, day]));
  messages.forEach((message) => {
    const date = new Date(message.createdTime || "");
    if (!Number.isNaN(date.getTime())) {
      const day = index.get(date.toISOString().slice(0, 10));
      if (day) {
        day.count += 1;
      }
    }
  });

  return days;
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

function DailyActivity({days}) {
  const max = Math.max(1, ...days.map((day) => day.count));

  return (
    <section className="dashboard-section">
      <div className="section-heading">
        <h2>Last 7 Days</h2>
      </div>
      <div className="daily-chart">
        {days.map((day) => (
          <div className="daily-column" key={day.key}>
            <div className="daily-bar" style={{height: `${Math.max(8, (day.count / max) * 100)}%`}} />
            <strong>{day.count}</strong>
            <span>{day.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TokenUsageTimeseries({series, tokens, selectedTokenId, onSelectedTokenId}) {
  const maxTokens = Math.max(1, ...series.map((day) => day.totalTokens));
  const maxRequests = Math.max(1, ...series.map((day) => day.requests));
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
            {totals.requests} requests · {totals.totalTokens} tokens · {totals.promptTokens} prompt · {totals.responseTokens} response
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
        <div className="token-timeseries">
          {series.map((day) => {
            const promptPercent = day.totalTokens > 0 ? (day.promptTokens / day.totalTokens) * 100 : 0;
            const responsePercent = day.totalTokens > 0 ? (day.responseTokens / day.totalTokens) * 100 : 0;

            return (
              <div className="token-time-column" key={day.key} title={`${day.label}: ${day.requests} requests, ${day.totalTokens} tokens`}>
                <div className="request-marker" style={{height: `${day.requests > 0 ? Math.max(6, (day.requests / maxRequests) * 100) : 0}%`}} />
                <div className="token-stack" style={{height: `${Math.max(day.totalTokens > 0 ? 10 : 0, (day.totalTokens / maxTokens) * 100)}%`}}>
                  <div className="token-stack-response" style={{height: `${responsePercent}%`}} />
                  <div className="token-stack-prompt" style={{height: `${promptPercent}%`}} />
                </div>
                <strong>{day.totalTokens}</strong>
                <span>{day.label}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="chart-legend">
        <span><i className="legend-prompt" /> Prompt tokens</span>
        <span><i className="legend-response" /> Response tokens</span>
        <span><i className="legend-requests" /> Requests</span>
      </div>
    </section>
  );
}

function ApiReference({token, onCopy}) {
  const reference = useMemo(() => {
    const origin = window.location.origin;
    const baseUrl = `${origin}/api/v1`;
    const chatUrl = `${baseUrl}/chat/completions`;
    const model = "d-ai-casibase";
    const bearer = token?.value || "<TOKEN>";

    return {
      baseUrl,
      chatUrl,
      casibaseUrl: `${origin}/casibase`,
      model,
      authHeader: `Authorization: Bearer ${bearer}`,
      curl: [
        `curl '${chatUrl}' \\`,
        `  -H 'Authorization: Bearer ${bearer}' \\`,
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
          <p className="side-note">Use an active D-AI token as a bearer token for this custom model endpoint.</p>
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
          <span>Casibase Proxy Base</span>
          <code>{reference.casibaseUrl}</code>
          <button className="small-button" onClick={() => onCopy("Casibase proxy base", reference.casibaseUrl)}>Copy</button>
        </div>
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

  function updateLimit(field, value) {
    if (!token) {
      return;
    }

    onUpdateTokenLimits(token.id, {
      ...limits,
      [field]: value,
    });
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
                value={limits.totalTokens || ""}
                onChange={(event) => updateLimit("totalTokens", event.target.value)}
              />
            </label>
            <label>
              Requests / minute
              <input
                min="0"
                type="number"
                value={limits.requestsPerMinute || 0}
                onChange={(event) => updateLimit("requestsPerMinute", event.target.value)}
              />
            </label>
            <label>
              Requests / hour
              <input
                min="0"
                type="number"
                value={limits.requestsPerHour || 0}
                onChange={(event) => updateLimit("requestsPerHour", event.target.value)}
              />
            </label>
            <label>
              Requests / day
              <input
                min="0"
                type="number"
                value={limits.requestsPerDay || 0}
                onChange={(event) => updateLimit("requestsPerDay", event.target.value)}
              />
            </label>
            <label>
              Tokens / day
              <input
                min="0"
                type="number"
                value={limits.tokensPerDay || 0}
                onChange={(event) => updateLimit("tokensPerDay", event.target.value)}
              />
            </label>
          </div>
        </>
      )}
    </section>
  );
}

function DashboardPage({account, onLogout, onNavigate}) {
  const [stores, setStores] = useState([]);
  const [chats, setChats] = useState([]);
  const [messagesByChat, setMessagesByChat] = useState({});
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
    const allMessages = Object.values(messagesByChat).flat();
    const userMessages = allMessages.filter((message) => message.author === account.name);
    const assistantMessages = allMessages.filter((message) => message.author === "AI");
    const today = startOfToday();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 6);
    const messagesToday = allMessages.filter((message) => new Date(message.createdTime || "") >= today);
    const messagesThisWeek = allMessages.filter((message) => new Date(message.createdTime || "") >= sevenDaysAgo);
    const storeNames = new Map(stores.map((store) => [store.name, store.displayName || store.name]));
    const chatRows = chats.map((item) => ({
      ...item,
      actualMessageCount: messagesByChat[item.name]?.length || item.messageCount || 0,
    }));
    const sortedChats = [...chatRows].sort((left, right) => {
      const leftTime = new Date(left.updatedTime || left.createdTime || 0).getTime();
      const rightTime = new Date(right.updatedTime || right.createdTime || 0).getTime();
      return rightTime - leftTime;
    });
    const lastActive = sortedChats[0]?.updatedTime || sortedChats[0]?.createdTime || account.lastSigninTime;
    const modelCounts = countBy(allMessages, (message) => message.modelProvider);
    const storeCounts = countBy(chats, (item) => storeNames.get(item.store) || item.store);

    return {
      allMessages,
      userMessages,
      assistantMessages,
      messagesToday,
      messagesThisWeek,
      sortedChats,
      lastActive,
      promptWords: wordsIn(userMessages),
      answerWords: wordsIn(assistantMessages),
      modelEntries: topEntries(modelCounts),
      storeEntries: topEntries(storeCounts),
      dailyUsage: buildDailyUsage(allMessages),
    };
  }, [account, chats, messagesByChat, stores]);

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/dashboard" onLogout={logout} onNavigate={onNavigate} />

      <section className="dashboard-layout">
        <div className="dashboard-title">
          <div>
            <p className="eyebrow">Signed in as {account.name}</p>
            <h2>Usage Dashboard</h2>
          </div>
          <button className="primary-button" disabled={isLoading} onClick={loadUsage}>
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="stats-grid" aria-label="Usage totals">
          <StatCard label="Chats" value={chats.length} detail={`${usage.sortedChats.filter((chat) => chat.actualMessageCount > 0).length} with messages`} />
          <StatCard label="Messages" value={usage.allMessages.length} detail={`${usage.messagesToday.length} today`} />
          <StatCard label="Prompts" value={usage.userMessages.length} detail={`${usage.promptWords} prompt words`} />
          <StatCard label="Answers" value={usage.assistantMessages.length} detail={`${usage.answerWords} answer words`} />
          <StatCard label="Last active" value={formatChatTime(usage.lastActive)} detail={`Login: ${formatFullTime(account.lastSigninTime)}`} />
          <StatCard label="This week" value={usage.messagesThisWeek.length} detail="messages in the last 7 days" />
        </section>

        <div className="dashboard-grid">
          <DailyActivity days={usage.dailyUsage} />
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

function TokensPage({account, tokenData, onCreateToken, onToggleToken, onDeleteToken, onLogout, onNavigate, onUpdateTokenLimits}) {
  const [name, setName] = useState("");
  const [tokenLimit, setTokenLimit] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedSeriesTokenId, setSelectedSeriesTokenId] = useState("all");
  const [selectedLimitTokenId, setSelectedLimitTokenId] = useState("");
  const summaries = useMemo(() => getTokenUsageSummary(tokenData), [tokenData]);
  const referenceToken = tokenData.tokens.find(isTokenActive) || tokenData.tokens[0];
  const seriesUsage = useMemo(() => {
    if (selectedSeriesTokenId === "all") {
      return tokenData.usage;
    }

    return tokenData.usage.filter((entry) => entry.tokenId === selectedSeriesTokenId);
  }, [selectedSeriesTokenId, tokenData.usage]);
  const usageSeries = useMemo(() => buildTokenUsageSeries(seriesUsage), [seriesUsage]);
  const recentUsage = [...tokenData.usage].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 10);

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

  function submit(event) {
    event.preventDefault();
    const trimmedLimit = tokenLimit.trim();
    const totalTokens = trimmedLimit ? Math.floor(Number(trimmedLimit)) : 0;

    if (!Number.isFinite(totalTokens) || totalTokens < 0) {
      setFormError("Token quota must be 0 or greater.");
      setNotice("");
      return;
    }

    const token = onCreateToken(name, {totalTokens});
    setName("");
    setTokenLimit("");
    setFormError("");
    setNotice(`${token.name} created`);
  }

  function deleteToken(token) {
    if (window.confirm(`Delete ${token.name}?`)) {
      onDeleteToken(token.id);
      setNotice(`${token.name} deleted`);
    }
  }

  useEffect(() => {
    if (selectedSeriesTokenId !== "all" && !tokenData.tokens.some((token) => token.id === selectedSeriesTokenId)) {
      setSelectedSeriesTokenId("all");
    }

    if (!tokenData.tokens.some((token) => token.id === selectedLimitTokenId)) {
      setSelectedLimitTokenId(tokenData.tokens[0]?.id || "");
    }
  }, [selectedLimitTokenId, selectedSeriesTokenId, tokenData.tokens]);

  return (
    <main className="chat-shell">
      <AppHeader account={account} currentPath="/tokens" onLogout={logout} onNavigate={onNavigate} />

      <section className="dashboard-layout">
        <div className="dashboard-title">
          <div>
            <p className="eyebrow">Signed in as {account.name}</p>
            <h2>Token Management</h2>
          </div>
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
            <button className="primary-button">Create token</button>
          </form>
        </div>

        {formError ? <div className="error-banner">{formError}</div> : null}
        {notice ? <div className="success-banner">{notice}</div> : null}

        <section className="stats-grid" aria-label="Token totals">
          <StatCard label="Tokens" value={tokenData.tokens.length} detail={`${tokenData.tokens.filter(isTokenActive).length} active`} />
          <StatCard label="Requests" value={summaries.totals.requests} detail="tracked chat turns" />
          <StatCard label="Token usage" value={summaries.totals.totalTokens} detail={`${summaries.totals.promptTokens} prompt, ${summaries.totals.responseTokens} response`} />
          <StatCard label="Prompt tokens" value={summaries.totals.promptTokens} detail="from selected token turns" />
          <StatCard label="Response tokens" value={summaries.totals.responseTokens} detail="from selected token turns" />
          <StatCard label="Cost" value={summaries.totals.price.toFixed(4)} detail="reported by Casibase messages" />
        </section>

        <TokenUsageTimeseries
          selectedTokenId={selectedSeriesTokenId}
          series={usageSeries}
          tokens={tokenData.tokens}
          onSelectedTokenId={setSelectedSeriesTokenId}
        />

        <RateLimitTracker
          selectedTokenId={selectedLimitTokenId}
          tokenData={tokenData}
          onSelectedTokenId={setSelectedLimitTokenId}
          onUpdateTokenLimits={onUpdateTokenLimits}
        />

        <ApiReference token={referenceToken} onCopy={copyText} />

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

                return (
                  <article className="token-row" key={token.id}>
                    <div className="token-main">
                      <strong>{token.name}</strong>
                      <code>{maskToken(token.value)}</code>
                    </div>
                    <span className={`status-pill ${isTokenActive(token) ? "active" : "inactive"}`}>{token.status}</span>
                    <div className="token-usage">
                      <span>{usage.requests || 0} requests</span>
                      <span>{usage.totalTokens || 0} / {limitText(token.limits?.totalTokens || 0)} quota</span>
                      <span>{formatChatTime(usage.lastUsedAt || token.lastUsedAt)}</span>
                    </div>
                    <div className="token-actions">
                      <button className="small-button" onClick={() => copyToken(token)}>Copy</button>
                      <button className="small-button" onClick={() => onToggleToken(token.id)}>
                        {isTokenActive(token) ? "Deactivate" : "Activate"}
                      </button>
                      <button className="small-button danger" onClick={() => deleteToken(token)}>Delete</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="dashboard-section token-section">
          <div className="section-heading">
            <h2>Recent Token Usage</h2>
          </div>
          {recentUsage.length === 0 ? (
            <p className="side-note">No token usage yet.</p>
          ) : (
            <div className="recent-table">
              {recentUsage.map((entry) => {
                const token = tokenData.tokens.find((item) => item.id === entry.tokenId);

                return (
                  <div className="recent-row token-usage-row" key={entry.id}>
                    <strong>{token?.name || "Deleted token"}</strong>
                    <span>{entry.totalTokens} tokens</span>
                    <span>{entry.chatTitle || entry.chatName}</span>
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

function ChatPage({account, onLogout, onNavigate, tokenData, onRecordTokenUsage}) {
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
  const closeStreamRef = useRef(null);
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

  async function newChat() {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    setChat(null);
    setMessages([]);
    setStreamingText("");
    setReasonText("");
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
    setChat(nextChat);
    if (nextChat.store) {
      setStoreName(nextChat.store);
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

  async function sendPrompt(text) {
    setIsSending(true);
    setStreamingText("");
    setReasonText("");

    try {
      const usageToken = selectedToken;
      const activeChat = chat || await createChat({account, store: selectedStore});
      setChat(activeChat);

      setMessages((current) => [
        ...current,
        {
          owner: "admin",
          name: `local_${Date.now()}`,
          author: account.name,
          text,
          modelProvider: selectedStore?.modelProvider || "",
        },
      ]);

      const updatedChat = await sendChatMessage({account, chat: activeChat, store: selectedStore, text});
      setChat(updatedChat);
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
            promptText: text,
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
        promptText: text,
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
                promptText: text,
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
      setError(error.message);
      setIsSending(false);
      setStreamingText("");
      setReasonText("");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();

    if (!text) {
      return;
    }

    if (selectedToken) {
      const limitStatus = getTokenLimitStatus(selectedToken, tokenData.usage, estimateTokenCount(text));
      if (!limitStatus.allowed) {
        setError(`Token limit exceeded: ${limitStatus.reasons.join("; ")}`);
        return;
      }
    }

    setInput("");
    setError("");

    if (isSending) {
      await interruptStream();
    }

    await sendPrompt(text);
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
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={isSending ? "Steer the current response" : "Send a message to Casibase"}
            disabled={isLoadingStores || !selectedStore}
            rows={3}
          />
          <div className="composer-actions">
            {isSending ? (
              <button className="ghost-button stop-button" onClick={() => interruptStream()} type="button">
                Stop
              </button>
            ) : null}
            <button className="primary-button" disabled={isLoadingStores || !selectedStore || !input.trim()}>
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

  function updateTokenData(updater) {
    setTokenData((current) => {
      const next = updater(current);
      persistTokenData(next);
      return next;
    });
  }

  function createManagedToken(name, limits) {
    const token = createTokenRecord(name, limits);
    updateTokenData((current) => ({
      ...current,
      tokens: [token, ...current.tokens],
    }));
    return token;
  }

  function toggleManagedToken(tokenId) {
    updateTokenData((current) => ({
      ...current,
      tokens: current.tokens.map((token) => token.id === tokenId
        ? {...token, status: isTokenActive(token) ? "Inactive" : "Active"}
        : token),
    }));
  }

  function updateManagedTokenLimits(tokenId, limits) {
    updateTokenData((current) => ({
      ...current,
      tokens: current.tokens.map((token) => token.id === tokenId
        ? {...token, limits: normalizeTokenLimits(limits)}
        : token),
    }));
  }

  function deleteManagedToken(tokenId) {
    updateTokenData((current) => ({
      ...current,
      tokens: current.tokens.filter((token) => token.id !== tokenId),
      usage: current.usage.filter((entry) => entry.tokenId !== tokenId),
    }));
  }

  function recordManagedTokenUsage(entry) {
    updateTokenData((current) => ({
      ...current,
      tokens: current.tokens.map((token) => token.id === entry.tokenId ? {...token, lastUsedAt: entry.createdAt} : token),
      usage: [entry, ...current.usage].slice(0, 500),
    }));
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
        saveTokenState(account, synced);
        setTokenData(synced);
      })
      .catch(() => null);
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
      onLogout={() => setAccount(null)}
      onNavigate={navigate}
      onRecordTokenUsage={recordManagedTokenUsage}
      tokenData={tokenData}
    />
  );
}
