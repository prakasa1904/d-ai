import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  estimateTokenCount,
  getTokenLimitStatus,
  normalizeTokenLimits,
} from "../src/tokens.js";

const apiModel = "d-ai-casibase";
const stateDirectory = ".d-ai-state";
const stateFilename = "tokens.json";
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

function now() {
  return new Date().toISOString();
}

function randomName() {
  return Math.random().toString(36).slice(2, 8);
}

function randomSecret(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function stableHash(value, length = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function fileExtension(fileName) {
  const dotIndex = String(fileName || "").lastIndexOf(".");
  return dotIndex >= 0 ? String(fileName).slice(dotIndex).toLowerCase() : "";
}

function isImageUpload({filename, type}) {
  return String(type || "").startsWith("image/") || imageFileExtensions.has(fileExtension(filename));
}

function emptyTokenState() {
  return {
    version: 1,
    tokens: [],
    usage: [],
    requestEvents: [],
  };
}

function emptyServerState() {
  return {
    version: 1,
    accounts: {},
  };
}

function accountKey(account) {
  return `${account?.owner || ""}/${account?.name || ""}`;
}

function publicAccount(account) {
  return {
    owner: account?.owner || "",
    name: account?.name || "",
    displayName: account?.displayName || account?.name || "",
  };
}

function normalizeToken(token) {
  return {
    ...token,
    limits: normalizeTokenLimits(token?.limits),
  };
}

function normalizeState(state) {
  return {
    ...emptyTokenState(),
    ...state,
    tokens: Array.isArray(state?.tokens) ? state.tokens.map(normalizeToken) : [],
    usage: Array.isArray(state?.usage) ? state.usage : [],
    requestEvents: Array.isArray(state?.requestEvents) ? state.requestEvents : [],
  };
}

function privateToken(token, account, sessionCookie) {
  return {
    ...normalizeToken(token),
    account: publicAccount(account),
    sessionCookie,
    updatedAt: token?.updatedAt || now(),
  };
}

function publicToken(token) {
  const {account, sessionCookie, updatedAt, ...rest} = token;
  return rest;
}

function publicTokenState(accountState = {}) {
  return {
    ...emptyTokenState(),
    tokens: Array.isArray(accountState.tokens) ? accountState.tokens.map(publicToken) : [],
    usage: Array.isArray(accountState.usage) ? accountState.usage : [],
    requestEvents: Array.isArray(accountState.requestEvents) ? accountState.requestEvents : [],
  };
}

function mergeUsage(left = [], right = []) {
  const byId = new Map();

  [...left, ...right].forEach((entry) => {
    if (entry?.id) {
      byId.set(entry.id, entry);
    }
  });

  return [...byId.values()]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 1000);
}

function mergeRequestEvents(left = [], right = []) {
  const byId = new Map();

  [...left, ...right].forEach((entry) => {
    if (entry?.id) {
      byId.set(entry.id, entry);
    }
  });

  return [...byId.values()]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 2000);
}

function requestEventFromUsage(usageRecord, event = {}) {
  const createdAt = event.createdAt || usageRecord?.createdAt || now();

  return {
    id: event.id || `req_${Date.now()}_${randomName()}`,
    tokenId: event.tokenId || usageRecord?.tokenId || "",
    createdAt,
    status: event.status || "success",
    source: event.source || "chat",
    httpStatus: event.httpStatus || 200,
    errorType: event.errorType || "",
    errorMessage: event.errorMessage || "",
    failureStage: event.failureStage || "",
    promptTokens: Number(event.promptTokens ?? usageRecord?.promptTokens ?? 0),
    responseTokens: Number(event.responseTokens ?? usageRecord?.responseTokens ?? 0),
    totalTokens: Number(event.totalTokens ?? usageRecord?.totalTokens ?? 0),
    latencyMs: Number(event.latencyMs || 0),
    historyKey: event.historyKey || usageRecord?.historyKey || "",
    chatName: event.chatName || usageRecord?.chatName || "",
    chatTitle: event.chatTitle || usageRecord?.chatTitle || "",
    modelProvider: event.modelProvider || usageRecord?.modelProvider || "",
    usageId: event.usageId || usageRecord?.id || "",
  };
}

function failureRequestEvent({tokenId, source = "chat", httpStatus = 500, errorType = "server_error", errorMessage = "", failureStage = "server", promptTokens = 0, latencyMs = 0, historyKey = "", chatName = "", chatTitle = "", modelProvider = ""}) {
  return {
    id: `req_${Date.now()}_${randomName()}`,
    tokenId,
    createdAt: now(),
    status: "failed",
    source,
    httpStatus,
    errorType,
    errorMessage,
    failureStage,
    promptTokens: Number(promptTokens || 0),
    responseTokens: 0,
    totalTokens: Number(promptTokens || 0),
    latencyMs: Number(latencyMs || 0),
    historyKey,
    chatName,
    chatTitle,
    modelProvider,
    usageId: "",
  };
}

function getStatePath(root) {
  return path.join(root, stateDirectory, stateFilename);
}

async function loadServerState(root) {
  try {
    const text = await fs.readFile(getStatePath(root), "utf8");
    return {
      ...emptyServerState(),
      ...JSON.parse(text),
    };
  } catch {
    return emptyServerState();
  }
}

async function saveServerState(root, state) {
  const file = getStatePath(root);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function signedInAccount({request, casibaseTarget}) {
  const sessionCookie = request.headers.cookie || "";
  const client = casibaseClient(casibaseTarget);
  const account = assertCasibaseOk(
    await client.get("/api/get-account", sessionCookie),
    "Please sign in first",
  ).data;

  if (!account?.owner || !account?.name) {
    throw new Error("Please sign in first");
  }

  return {account, sessionCookie};
}

function ensureAccountState(state, account, sessionCookie) {
  const key = accountKey(account);
  const previous = state.accounts[key] || {};
  const accountState = {
    account: publicAccount(account),
    sessionCookie: sessionCookie || previous.sessionCookie || "",
    tokens: Array.isArray(previous.tokens) ? previous.tokens : [],
    usage: Array.isArray(previous.usage) ? previous.usage : [],
    requestEvents: Array.isArray(previous.requestEvents) ? previous.requestEvents : [],
    updatedAt: now(),
  };

  state.accounts[key] = accountState;
  return {key, accountState};
}

function createServerToken(name, limits, account, sessionCookie) {
  const createdAt = now();
  const suffix = randomName();
  return privateToken({
    id: `tok_${Date.now()}_${suffix}`,
    name: String(name || "").trim() || `D-AI Token ${suffix}`,
    value: `dai_${randomSecret(32)}`,
    status: "Active",
    createdAt,
    lastUsedAt: "",
    limits: normalizeTokenLimits(limits),
    updatedAt: createdAt,
  }, account, sessionCookie);
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request) {
  const text = await readRequestBody(request);

  if (!text.trim()) {
    return {};
  }

  return JSON.parse(text);
}

function requestHeaders(headers) {
  const result = new Headers();

  Object.entries(headers || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => result.append(key, item));
    } else if (value !== undefined) {
      result.set(key, String(value));
    }
  });

  return result;
}

async function readFormDataBody(request) {
  const host = request.headers.host || "localhost";
  const webRequest = new Request(`http://${host}${request.url || "/"}`, {
    method: request.method,
    headers: requestHeaders(request.headers),
    body: request,
    duplex: "half",
  });

  return webRequest.formData();
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message, type = "invalid_request_error") {
  sendJson(response, status, {
    error: {
      message,
      type,
    },
  });
}

function assertCasibaseOk(payload, fallback) {
  if (payload?.status !== "ok") {
    throw new Error(payload?.msg || fallback);
  }

  return payload;
}

async function readCasibaseJson(response) {
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from Casibase, got: ${text.slice(0, 160)}`);
  }

  if (!response.ok) {
    throw new Error(payload?.msg || `${response.status} ${response.statusText}`);
  }

  return payload;
}

function casibaseHeaders(sessionCookie, contentType = false) {
  return {
    "Accept-Language": "en",
    ...(contentType ? {"Content-Type": "text/plain;charset=UTF-8"} : {}),
    ...(sessionCookie ? {Cookie: sessionCookie} : {}),
  };
}

function casibaseClient(casibaseTarget) {
  return {
    async get(pathname, sessionCookie) {
      const response = await fetch(`${casibaseTarget}${pathname}`, {
        headers: casibaseHeaders(sessionCookie),
      });
      return readCasibaseJson(response);
    },
    async post(pathname, body, sessionCookie) {
      const response = await fetch(`${casibaseTarget}${pathname}`, {
        method: "POST",
        headers: casibaseHeaders(sessionCookie, true),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return readCasibaseJson(response);
    },
    async stream(pathname, sessionCookie) {
      const response = await fetch(`${casibaseTarget}${pathname}`, {
        headers: casibaseHeaders(sessionCookie),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `${response.status} ${response.statusText}`);
      }

      return response.body;
    },
  };
}

async function loginCasdoorForCode({casdoorTarget, casdoorClientId, casdoorRedirectUri, organization, username, password}) {
  const state = `d-ai-admin-${Date.now()}-${randomName()}`;
  const query = new URLSearchParams({
    clientId: casdoorClientId,
    responseType: "code",
    redirectUri: casdoorRedirectUri,
    type: "code",
    scope: "profile",
    state,
    nonce: "",
    code_challenge_method: "",
    code_challenge: "",
  });
  const response = await fetch(`${casdoorTarget}/api/login?${query.toString()}`, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=UTF-8", "Accept-Language": "en"},
    body: JSON.stringify({
      username,
      password,
      organization,
      application: "casibase",
      signinMethod: "Password",
      type: "code",
      language: "",
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.status !== "ok" || !payload?.data) {
    throw new Error(payload?.msg || "Failed to sign in as Casibase upload admin");
  }

  return {code: payload.data, state};
}

function cookieHeaderFromResponse(response) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function getCasibaseAdminSession({
  casibaseTarget,
  casdoorTarget,
  casdoorClientId,
  casdoorRedirectUri,
  adminOrganization,
  adminUsername,
  adminPassword,
}) {
  if (!adminOrganization || !adminUsername || !adminPassword) {
    throw new Error("Missing Casibase upload admin credentials");
  }

  const {code, state} = await loginCasdoorForCode({
    casdoorTarget,
    casdoorClientId,
    casdoorRedirectUri,
    organization: adminOrganization,
    username: adminUsername,
    password: adminPassword,
  });
  const response = await fetch(`${casibaseTarget}/api/signin?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=UTF-8", "Accept-Language": "en"},
  });
  const sessionCookie = cookieHeaderFromResponse(response);
  const payload = await readCasibaseJson(response);
  assertCasibaseOk(payload, "Failed to open Casibase upload admin session");

  if (!sessionCookie) {
    throw new Error("Casibase upload admin session did not return a session cookie");
  }

  return sessionCookie;
}

async function syncTokenState({request, response, root, casibaseTarget}) {
  if (request.method === "GET") {
    const {account, sessionCookie} = await signedInAccount({request, casibaseTarget});
    const state = await loadServerState(root);
    const {accountState} = ensureAccountState(state, account, sessionCookie);
    await saveServerState(root, state);
    sendJson(response, 200, {status: "ok", data: publicTokenState(accountState)});
    return;
  }

  if (request.method !== "POST") {
    sendError(response, 405, "Only GET and POST are supported");
    return;
  }

  const {account, sessionCookie} = await signedInAccount({request, casibaseTarget});
  const body = await readJsonBody(request);
  const incoming = normalizeState(body.state);
  const state = await loadServerState(root);
  const {accountState} = ensureAccountState(state, account, sessionCookie);

  // Legacy bootstrap: if the server does not have tokens yet, import the browser cache once.
  // After that, server-side token actions are authoritative and stale browser snapshots
  // cannot silently overwrite updated limits.
  if (accountState.tokens.length === 0 && incoming.tokens.length > 0) {
    accountState.tokens = incoming.tokens.map((token) => privateToken(token, account, sessionCookie));
  }
  accountState.usage = mergeUsage(accountState.usage, incoming.usage);
  accountState.requestEvents = mergeRequestEvents(accountState.requestEvents, incoming.requestEvents);
  accountState.updatedAt = now();

  await saveServerState(root, state);
  sendJson(response, 200, {status: "ok", data: publicTokenState(accountState)});
}

async function mutateTokenState({request, response, root, casibaseTarget}) {
  if (request.method !== "POST") {
    sendError(response, 405, "Only POST is supported");
    return;
  }

  const {account, sessionCookie} = await signedInAccount({request, casibaseTarget});
  const body = await readJsonBody(request);
  const state = await loadServerState(root);
  const {accountState} = ensureAccountState(state, account, sessionCookie);
  let changedToken = null;

  if (body.action === "create-token") {
    changedToken = createServerToken(body.name, body.limits, account, sessionCookie);
    accountState.tokens = [changedToken, ...accountState.tokens];
  } else if (body.action === "toggle-token") {
    accountState.tokens = accountState.tokens.map((token) => {
      if (token.id !== body.tokenId) {
        return token;
      }

      changedToken = {
        ...token,
        status: token.status === "Active" ? "Inactive" : "Active",
        updatedAt: now(),
      };
      return changedToken;
    });
  } else if (body.action === "update-token-limits") {
    accountState.tokens = accountState.tokens.map((token) => {
      if (token.id !== body.tokenId) {
        return token;
      }

      changedToken = {
        ...token,
        limits: normalizeTokenLimits(body.limits),
        updatedAt: now(),
      };
      return changedToken;
    });
  } else if (body.action === "delete-token") {
    const existed = accountState.tokens.some((token) => token.id === body.tokenId);
    accountState.tokens = accountState.tokens.filter((token) => token.id !== body.tokenId);
    accountState.usage = accountState.usage.filter((entry) => entry.tokenId !== body.tokenId);
    accountState.requestEvents = accountState.requestEvents.filter((entry) => entry.tokenId !== body.tokenId);
    changedToken = existed ? {id: body.tokenId} : null;
  } else if (body.action === "record-usage") {
    const entry = {
      ...body.entry,
      id: body.entry?.id || `use_${Date.now()}_${randomName()}`,
      createdAt: body.entry?.createdAt || now(),
    };

    if (!entry.tokenId) {
      sendError(response, 400, "Missing tokenId for usage record");
      return;
    }

    accountState.usage = mergeUsage([entry], accountState.usage);
    accountState.requestEvents = mergeRequestEvents([requestEventFromUsage(entry, body.event)], accountState.requestEvents);
    accountState.tokens = accountState.tokens.map((token) => token.id === entry.tokenId
      ? {...token, lastUsedAt: entry.createdAt, updatedAt: now()}
      : token);
  } else if (body.action === "record-request") {
    const event = {
      ...body.event,
      id: body.event?.id || `req_${Date.now()}_${randomName()}`,
      createdAt: body.event?.createdAt || now(),
      status: body.event?.status || "failed",
    };

    if (!event.tokenId) {
      sendError(response, 400, "Missing tokenId for request event");
      return;
    }

    accountState.requestEvents = mergeRequestEvents([event], accountState.requestEvents);
  } else {
    sendError(response, 400, "Unsupported token action");
    return;
  }

  if (["toggle-token", "update-token-limits"].includes(body.action) && !changedToken) {
    sendError(response, 404, "Token was not found");
    return;
  }

  accountState.updatedAt = now();
  await saveServerState(root, state);

  sendJson(response, 200, {
    status: "ok",
    data: {
      state: publicTokenState(accountState),
      token: changedToken ? publicToken(changedToken) : null,
    },
  });
}

async function checkTokenLimit({request, response, root, casibaseTarget}) {
  if (request.method !== "POST") {
    sendError(response, 405, "Only POST is supported");
    return;
  }

  const {account, sessionCookie} = await signedInAccount({request, casibaseTarget});
  const body = await readJsonBody(request);
  const state = await loadServerState(root);
  const {key, accountState} = ensureAccountState(state, account, sessionCookie);
  const token = accountState.tokens.find((item) => item.id === body.tokenId);
  const pendingTokens = Number(body.pendingTokens || 0) || estimateTokenCount(body.promptText || "");

  if (!token) {
    sendError(response, 404, "Token was not found");
    return;
  }

  if (token.status !== "Active") {
    accountState.requestEvents = mergeRequestEvents([
      failureRequestEvent({
        tokenId: token.id,
        source: "chat",
        httpStatus: 401,
        errorType: "authentication_error",
        errorMessage: "D-AI token is inactive",
        failureStage: "auth",
        promptTokens: pendingTokens,
      }),
    ], accountState.requestEvents);
    await saveServerState(root, state);
    sendError(response, 401, "D-AI token is inactive", "authentication_error");
    return;
  }

  const limitStatus = getTokenLimitStatus(token, accountState.usage, pendingTokens);
  if (!limitStatus.allowed) {
    accountState.requestEvents = mergeRequestEvents([
      failureRequestEvent({
        tokenId: token.id,
        source: "chat",
        httpStatus: 429,
        errorType: "rate_limit_exceeded",
        errorMessage: limitStatus.reasons.join("; "),
        failureStage: "limit_check",
        promptTokens: pendingTokens,
      }),
    ], accountState.requestEvents);
    state.accounts[key] = accountState;
    await saveServerState(root, state);
    sendError(response, 429, limitStatus.reasons.join("; "), "rate_limit_exceeded");
    return;
  }

  await saveServerState(root, state);
  sendJson(response, 200, {
    status: "ok",
    data: {
      allowed: true,
      state: publicTokenState(accountState),
      token: publicToken(token),
    },
  });
}

async function exchangeCasdoorToken({request, response, casdoorTarget, casdoorClientId, casdoorClientSecret, casdoorRedirectUri}) {
  if (request.method !== "POST") {
    sendError(response, 405, "Only POST is supported");
    return;
  }

  const body = await readJsonBody(request);
  if (!body.code) {
    sendError(response, 400, "Missing Casdoor authorization code");
    return;
  }

  if (!casdoorClientSecret) {
    sendError(response, 500, "Missing Casdoor client secret", "server_error");
    return;
  }

  const tokenResponse = await fetch(`${casdoorTarget}/api/login/oauth/access_token`, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: casdoorClientId,
      client_secret: casdoorClientSecret,
      code: body.code,
      redirect_uri: casdoorRedirectUri,
    }),
  });
  const payload = await tokenResponse.json().catch(() => null);

  if (!tokenResponse.ok || !payload?.access_token) {
    sendError(response, tokenResponse.status || 500, payload?.error_description || payload?.error || "Failed to exchange Casdoor token");
    return;
  }

  sendJson(response, 200, {
    status: "ok",
    data: {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
      tokenType: payload.token_type || "Bearer",
    },
  });
}

async function uploadChatFile({
  request,
  response,
  casibaseTarget,
  casdoorTarget,
  casdoorClientId,
  casdoorRedirectUri,
  sharedStoreId,
  uploadAdmin,
}) {
  if (request.method !== "POST") {
    sendError(response, 405, "Only POST is supported");
    return;
  }

  const browserSessionCookie = request.headers.cookie || "";
  const client = casibaseClient(casibaseTarget);
  const account = assertCasibaseOk(
    await client.get("/api/get-account", browserSessionCookie),
    "Please sign in before uploading files",
  ).data;

  if (!account?.name) {
    sendError(response, 401, "Please sign in before uploading files", "authentication_error");
    return;
  }

  const formData = await readFormDataBody(request);
  const file = formData.get("file");

  if (!file || typeof file.arrayBuffer !== "function") {
    sendError(response, 400, "Missing upload file");
    return;
  }

  const storeId = String(formData.get("storeId") || sharedStoreId);
  if (storeId !== sharedStoreId) {
    sendError(response, 403, `Uploads are restricted to ${sharedStoreId}`);
    return;
  }

  const [, storeName = ""] = storeId.split("/");
  const rawKey = String(formData.get("key") || `d-ai/${account.name}/${randomName()}`);
  const key = rawKey.replace(/^\/+|\/+$/g, "");
  const filename = String(formData.get("filename") || file.name || `upload-${Date.now()}`);

  if (!isImageUpload({filename, type: file.type || ""})) {
    sendError(response, 400, "Only image files can be uploaded.");
    return;
  }

  const objectKey = [key, filename].filter(Boolean).join("/");
  const adminSessionCookie = await getCasibaseAdminSession({
    casibaseTarget,
    casdoorTarget,
    casdoorClientId,
    casdoorRedirectUri,
    adminOrganization: uploadAdmin.organization,
    adminUsername: uploadAdmin.username,
    adminPassword: uploadAdmin.password,
  });
  const uploadForm = new FormData();
  uploadForm.append("file", file, filename);
  const query = new URLSearchParams({
    store: storeId,
    key,
    isLeaf: "1",
    filename,
  });
  const uploadResponse = await fetch(`${casibaseTarget}/api/add-tree-file?${query.toString()}`, {
    method: "POST",
    headers: casibaseHeaders(adminSessionCookie),
    body: uploadForm,
  });
  const uploadPayload = await readCasibaseJson(uploadResponse);
  assertCasibaseOk(uploadPayload, "Failed to upload file");

  let record = null;
  try {
    const filesPayload = await client.get(`/api/get-files?owner=admin&store=${encodeURIComponent(storeName)}`, adminSessionCookie);
    const files = assertCasibaseOk(filesPayload, "Failed to load uploaded file record").data || [];
    const expectedName = `${storeName}_${objectKey}`;
    record = files.find((item) => item.name === expectedName)
      || files.find((item) => item.filename === filename && item.store === storeName)
      || null;
  } catch {
    record = null;
  }

  sendJson(response, 200, {
    status: "ok",
    data: {
      filename,
      objectKey,
      size: Number(file.size || 0),
      type: file.type || "",
      record,
    },
  });
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || "";
}

function findToken(state, value) {
  for (const [key, accountState] of Object.entries(state.accounts || {})) {
    const token = accountState.tokens?.find((item) => item.value === value);

    if (token) {
      return {
        key,
        token,
        accountState,
      };
    }
  }

  return null;
}

function apiTokenAuth(request, state) {
  const bearer = getBearerToken(request);

  if (!bearer) {
    return {error: {status: 401, message: "Missing bearer token", type: "authentication_error"}};
  }

  const match = findToken(state, bearer);
  if (!match) {
    return {error: {status: 401, message: "Invalid D-AI token", type: "authentication_error"}};
  }

  if (match.token.status !== "Active") {
    return {error: {status: 401, message: "D-AI token is inactive", type: "authentication_error"}};
  }

  return {match};
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || part?.content || "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content || "");
}

function normalizeHistoryKey(value) {
  return String(value || "default").trim().slice(0, 80) || "default";
}

function historyKeyFromRecord(record) {
  const direct = record?.historyKey || record?.dAiHistoryKey || record?.conversationId;
  if (direct) {
    return normalizeHistoryKey(direct);
  }

  const title = String(record?.chatTitle || "");
  const prefix = "D-AI API - ";
  if (title.startsWith(prefix)) {
    return normalizeHistoryKey(title.slice(prefix.length));
  }

  return "";
}

function historyKeyFromRequest(request, body) {
  return normalizeHistoryKey(
    request.headers["x-d-ai-history-key"]
      || request.headers["x-dai-history-key"]
      || body.historyKey
      || body.conversationId
      || body.metadata?.dAiHistoryKey
      || body.metadata?.historyKey
      || body.metadata?.conversationId
      || "default",
  );
}

function chatNameForHistory({account, token, historyKey}) {
  const tokenPart = String(token?.id || "token").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 38);
  const hash = stableHash(`${account?.owner || ""}/${account?.name || ""}/${token?.id || ""}/${historyKey}`);
  return `chat_dai_api_${tokenPart}_${hash}`;
}

function emptyApiHistory(token, historyKey) {
  return {
    id: historyKey,
    object: "d_ai.api_history",
    historyKey,
    tokenId: token?.id || "",
    tokenName: token?.name || "",
    chatName: "",
    chatTitle: `D-AI API - ${historyKey}`,
    createdAt: "",
    lastUsedAt: "",
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    lastStatus: "",
    lastHttpStatus: 0,
    lastError: "",
    lastFailureStage: "",
    lastModelProvider: "",
  };
}

function ensureApiHistory(byKey, token, historyKey) {
  const normalized = normalizeHistoryKey(historyKey);
  if (!byKey.has(normalized)) {
    byKey.set(normalized, emptyApiHistory(token, normalized));
  }
  return byKey.get(normalized);
}

function applyHistoryTimestamp(history, createdAt) {
  if (!createdAt) {
    return;
  }

  if (!history.createdAt || String(createdAt).localeCompare(String(history.createdAt)) < 0) {
    history.createdAt = createdAt;
  }

  if (!history.lastUsedAt || String(createdAt).localeCompare(String(history.lastUsedAt)) > 0) {
    history.lastUsedAt = createdAt;
  }
}

function applyHistoryMetadata(history, record = {}) {
  if (record.chatName) {
    history.chatName = record.chatName;
  }
  if (record.chatTitle) {
    history.chatTitle = record.chatTitle;
  }
  if (record.modelProvider) {
    history.lastModelProvider = record.modelProvider;
  }
}

function addHistoryTokens(history, record = {}) {
  history.promptTokens += Number(record.promptTokens || 0);
  history.responseTokens += Number(record.responseTokens || 0);
  history.totalTokens += Number(record.totalTokens || 0);
}

function buildApiHistories(accountState = {}, token = {}) {
  const byKey = new Map();
  const tokenId = token?.id || "";
  const usageCountedByEvent = new Set();

  (accountState.requestEvents || [])
    .filter((event) => event?.tokenId === tokenId && event?.source === "api")
    .forEach((event) => {
      const historyKey = historyKeyFromRecord(event);
      if (!historyKey) {
        return;
      }

      const history = ensureApiHistory(byKey, token, historyKey);
      history.requestCount += 1;
      if (event.status === "success") {
        history.successCount += 1;
      } else {
        history.failedCount += 1;
      }

      history.lastStatus = event.status || history.lastStatus;
      history.lastHttpStatus = Number(event.httpStatus || history.lastHttpStatus || 0);
      history.lastError = event.errorMessage || history.lastError;
      history.lastFailureStage = event.failureStage || history.lastFailureStage;

      applyHistoryTimestamp(history, event.createdAt);
      applyHistoryMetadata(history, event);
      addHistoryTokens(history, event);

      if (event.usageId) {
        usageCountedByEvent.add(event.usageId);
      }
    });

  (accountState.usage || [])
    .filter((entry) => entry?.tokenId === tokenId)
    .forEach((entry) => {
      const historyKey = historyKeyFromRecord(entry);
      if (!historyKey) {
        return;
      }

      const history = ensureApiHistory(byKey, token, historyKey);
      const alreadyCounted = entry.id && usageCountedByEvent.has(entry.id);

      if (!alreadyCounted) {
        history.requestCount += 1;
        history.successCount += 1;
        history.lastStatus = "success";
        history.lastHttpStatus = 200;
        addHistoryTokens(history, entry);
      }

      applyHistoryTimestamp(history, entry.createdAt);
      applyHistoryMetadata(history, entry);
    });

  return [...byKey.values()]
    .sort((a, b) => String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")));
}

function promptFromOpenAiMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastUser = [...rows].reverse().find((message) => message?.role === "user") || rows.at(-1);
  return messageContentToText(lastUser?.content).trim();
}

async function chooseStore(client, sessionCookie, sharedStoreId) {
  const result = await client.get(`/api/get-store?id=${encodeURIComponent(sharedStoreId)}`, sessionCookie);
  const store = assertCasibaseOk(result, "Failed to load shared store").data || null;

  if (!store) {
    throw new Error(`Shared store ${sharedStoreId} was not found. Update VITE_CASIBASE_SHARED_STORE_ID or restore the Casibase store name.`);
  }

  return store;
}

async function createChat(client, account, store, sessionCookie, options = {}) {
  const chatName = options.name || `chat_dai_api_${randomName()}`;
  const chat = {
    owner: "admin",
    name: chatName,
    store: store?.name || "",
    createdTime: now(),
    updatedTime: now(),
    organization: account.owner,
    displayName: options.displayName || `D-AI API - ${chatName.slice(-6)}`,
    category: "Default Category",
    type: "AI",
    user: account.name,
    user1: "",
    user2: "",
    users: [],
    clientIp: "",
    userAgent: options.userAgent || "D-AI API",
    messageCount: 0,
    needTitle: true,
    modelProvider: store?.modelProvider || "",
    toolProvider: "",
  };

  assertCasibaseOk(await client.post("/api/add-chat", chat, sessionCookie), "Failed to create chat");
  return chat;
}

async function getChat(client, chatName, sessionCookie) {
  const result = await client.get(`/api/get-chat?id=${encodeURIComponent(`admin/${chatName}`)}`, sessionCookie);
  return assertCasibaseOk(result, "Failed to load chat history").data || null;
}

async function getOrCreateApiChat({client, account, store, token, historyKey, sessionCookie}) {
  const chatName = chatNameForHistory({account, token, historyKey});

  try {
    const existing = await getChat(client, chatName, sessionCookie);
    if (existing) {
      return existing;
    }
  } catch {
    // Missing history is expected on the first request for a token/history key.
  }

  try {
    return await createChat(client, account, store, sessionCookie, {
      name: chatName,
      displayName: `D-AI API - ${historyKey}`,
      userAgent: `D-AI API history:${historyKey}`,
    });
  } catch (error) {
    const existing = await getChat(client, chatName, sessionCookie).catch(() => null);
    if (existing) {
      return existing;
    }
    throw error;
  }
}

async function sendChatMessage(client, {account, chat, store, promptText, sessionCookie}) {
  const modelProvider = store?.modelProvider || chat.modelProvider || "";
  const message = {
    owner: "admin",
    name: `message_dai_api_${randomName()}`,
    createdTime: now(),
    organization: account.owner,
    store: chat.store || store?.name || "",
    user: account.name,
    chat: chat.name,
    replyTo: "",
    author: account.name,
    text: promptText,
    isHidden: false,
    isDeleted: false,
    isAlerted: false,
    isRegenerated: false,
    fileName: "",
    webSearchEnabled: false,
    modelProvider,
  };

  const result = await client.post("/api/add-message", message, sessionCookie);
  return assertCasibaseOk(result, "Failed to send message").data || {...chat, modelProvider};
}

async function getMessages(client, chat, sessionCookie) {
  const result = await client.get(`/api/get-messages?owner=admin&chat=${encodeURIComponent(chat.name)}`, sessionCookie);
  return assertCasibaseOk(result, "Failed to load messages").data || [];
}

function messageTokenCount(message, fallbackText = "") {
  return Number(message?.tokenCount || 0) ||
    Number(message?.textTokenCount || 0) ||
    estimateTokenCount(message?.text || fallbackText);
}

function buildUsageRecord({tokenId, historyKey, chat, messages, answerName, promptText, streamedText}) {
  const answer = messages.find((message) => message.name === answerName) ||
    [...messages].reverse().find((message) => message.author === "AI");
  const prompt = answer?.replyTo
    ? messages.find((message) => message.name === answer.replyTo)
    : [...messages].reverse().find((message) => message.author !== "AI" && message.text === promptText);
  const promptTokens = messageTokenCount(prompt, promptText);
  const responseTokens = messageTokenCount(answer, streamedText);
  const price = Number(prompt?.price || 0) + Number(answer?.price || 0);

  return {
    id: `use_api_${Date.now()}_${randomName()}`,
    tokenId,
    historyKey,
    createdAt: now(),
    chatName: chat?.name || "",
    chatTitle: chat?.displayName || chat?.name || "",
    modelProvider: chat?.modelProvider || "",
    promptName: prompt?.name || "",
    answerName: answer?.name || answerName || "",
    promptTokens,
    responseTokens,
    totalTokens: promptTokens + responseTokens,
    price,
    currency: answer?.currency || prompt?.currency || "",
  };
}

async function saveUsage({root, key, tokenId, usageRecord}) {
  const state = await loadServerState(root);
  const accountState = state.accounts[key];

  if (!accountState) {
    return;
  }

  accountState.usage = mergeUsage([usageRecord], accountState.usage);
  accountState.requestEvents = mergeRequestEvents([requestEventFromUsage(usageRecord, {source: "api"})], accountState.requestEvents);
  accountState.tokens = (accountState.tokens || []).map((token) => token.id === tokenId
    ? {...token, lastUsedAt: usageRecord.createdAt}
    : token);
  accountState.updatedAt = now();

  await saveServerState(root, state);
}

async function saveRequestFailure({root, key, event}) {
  const state = await loadServerState(root);
  const accountState = state.accounts[key];

  if (!accountState) {
    return;
  }

  accountState.requestEvents = mergeRequestEvents([event], accountState.requestEvents);
  accountState.updatedAt = now();

  await saveServerState(root, state);
}

function writeSse(response, payload) {
  response.write(`data: ${payload}\n\n`);
}

function openAiChunk({id, model, delta = {}, finishReason = null}) {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  });
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];

  block.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  });

  return {
    event,
    data: data.join("\n"),
  };
}

async function readSseStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const {done, value} = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, {stream: true});

    while (buffer.includes("\n\n")) {
      const index = buffer.indexOf("\n\n");
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      if (block.trim()) {
        await onEvent(parseSseBlock(block));
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    await onEvent(parseSseBlock(buffer));
  }
}

async function readAnswer({client, answer, sessionCookie, onText}) {
  const stream = await client.stream(
    `/api/get-message-answer?id=${answer.owner}/${encodeURIComponent(answer.name)}`,
    sessionCookie,
  );
  let fullText = "";

  await readSseStream(stream, async ({event, data}) => {
    if (event === "message") {
      const payload = JSON.parse(data || "{}");
      const text = payload.text || "";
      fullText += text;
      onText?.(text);
    } else if (event === "myerror") {
      throw new Error(data || "Casibase stream failed");
    }
  });

  return fullText;
}

function completionResponse({id, model, content, usage}) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.responseTokens,
      total_tokens: usage.totalTokens,
    },
    d_ai: {
      history_key: usage.historyKey || "default",
      chat_name: usage.chatName || "",
      chat_title: usage.chatTitle || "",
    },
  };
}

function publicApiMessage(message) {
  return {
    id: message?.name || "",
    object: "d_ai.message",
    createdAt: message?.createdTime || "",
    role: message?.author === "AI" ? "assistant" : "user",
    content: message?.text || "",
    replyTo: message?.replyTo || "",
    tokenCount: messageTokenCount(message),
    modelProvider: message?.modelProvider || "",
  };
}

async function handleModels({request, response, root}) {
  if (request.method !== "GET") {
    sendError(response, 405, "Only GET is supported");
    return;
  }

  const state = await loadServerState(root);
  const {error} = apiTokenAuth(request, state);
  if (error) {
    sendError(response, error.status, error.message, error.type);
    return;
  }

  sendJson(response, 200, {
    object: "list",
    data: [
      {
        id: apiModel,
        object: "model",
        created: 0,
        owned_by: "d-ai",
      },
    ],
  });
}

async function handleApiHistories({request, response, root}) {
  if (request.method !== "GET") {
    sendError(response, 405, "Only GET is supported");
    return;
  }

  const state = await loadServerState(root);
  const {match, error} = apiTokenAuth(request, state);
  if (error) {
    sendError(response, error.status, error.message, error.type);
    return;
  }

  const url = new URL(request.url || "/", "http://localhost");
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 100);
  const histories = buildApiHistories(match.accountState, match.token);

  sendJson(response, 200, {
    object: "list",
    data: histories.slice(0, limit),
    has_more: histories.length > limit,
  });
}

async function handleApiHistoryDetail({request, response, root, casibaseTarget}) {
  if (request.method !== "GET") {
    sendError(response, 405, "Only GET is supported");
    return;
  }

  const state = await loadServerState(root);
  const {match, error} = apiTokenAuth(request, state);
  if (error) {
    sendError(response, error.status, error.message, error.type);
    return;
  }

  const url = new URL(request.url || "/", "http://localhost");
  const historyKey = normalizeHistoryKey(url.searchParams.get("key") || url.searchParams.get("historyKey") || "default");
  const account = match.token.account || match.accountState.account;
  const chatName = chatNameForHistory({account, token: match.token, historyKey});
  const knownHistory = buildApiHistories(match.accountState, match.token).find((history) => history.historyKey === historyKey);
  const history = knownHistory || emptyApiHistory(match.token, historyKey);
  const client = casibaseClient(casibaseTarget);
  let messages = [];

  if (match.accountState.sessionCookie) {
    const chat = await getChat(client, chatName, match.accountState.sessionCookie).catch(() => null);
    if (chat) {
      const rawMessages = await getMessages(client, chat, match.accountState.sessionCookie);
      history.chatName = chat.name || history.chatName;
      history.chatTitle = chat.displayName || history.chatTitle;
      history.lastModelProvider = chat.modelProvider || history.lastModelProvider;
      messages = rawMessages
        .filter((message) => !message?.isDeleted && !message?.isHidden)
        .map(publicApiMessage);
    }
  }

  sendJson(response, 200, {
    object: "d_ai.api_history",
    data: {
      ...history,
      chatName: history.chatName || chatName,
      messages,
    },
  });
}

async function runCasibaseTurn({client, account, historyKey = "default", promptText, sessionCookie, sharedStoreId, token}) {
  const store = await chooseStore(client, sessionCookie, sharedStoreId);

  if (!store) {
    throw new Error("No Casibase store is available");
  }

  const chat = token
    ? await getOrCreateApiChat({client, account, store, token, historyKey, sessionCookie})
    : await createChat(client, account, store, sessionCookie);
  const updatedChat = await sendChatMessage(client, {account, chat, store, promptText, sessionCookie});
  const messages = await getMessages(client, updatedChat, sessionCookie);
  const answer = [...messages].reverse().find((message) => message.author === "AI" && message.replyTo !== "") ||
    [...messages].reverse().find((message) => message.author === "AI");

  if (!answer) {
    throw new Error("Casibase did not create an answer message");
  }

  return {chat: updatedChat, answer};
}

async function handleChatCompletions({request, response, root, casibaseTarget, sharedStoreId}) {
  const requestStartedAt = Date.now();

  if (request.method !== "POST") {
    sendError(response, 405, "Only POST is supported");
    return;
  }

  const bearer = getBearerToken(request);
  if (!bearer) {
    sendError(response, 401, "Missing bearer token", "authentication_error");
    return;
  }

  const state = await loadServerState(root);
  const match = findToken(state, bearer);
  if (!match) {
    sendError(response, 401, "Invalid D-AI token", "authentication_error");
    return;
  }

  const body = await readJsonBody(request);
  const promptText = promptFromOpenAiMessages(body.messages);
  const promptTokens = estimateTokenCount(promptText);
  const historyKey = historyKeyFromRequest(request, body);

  if (match.token.status !== "Active") {
    await saveRequestFailure({
      root,
      key: match.key,
      event: failureRequestEvent({
        tokenId: match.token.id,
        source: "api",
        httpStatus: 401,
        errorType: "authentication_error",
        errorMessage: "D-AI token is inactive",
        failureStage: "auth",
        promptTokens,
        historyKey,
        latencyMs: Date.now() - requestStartedAt,
      }),
    });
    sendError(response, 401, "D-AI token is inactive", "authentication_error");
    return;
  }

  if (!match.accountState.sessionCookie) {
    await saveRequestFailure({
      root,
      key: match.key,
      event: failureRequestEvent({
        tokenId: match.token.id,
        source: "api",
        httpStatus: 401,
        errorType: "authentication_error",
        errorMessage: "Token is not synced with a signed-in browser session",
        failureStage: "auth",
        promptTokens,
        historyKey,
        latencyMs: Date.now() - requestStartedAt,
      }),
    });
    sendError(response, 401, "Token is not synced with a signed-in browser session", "authentication_error");
    return;
  }

  if (!promptText) {
    await saveRequestFailure({
      root,
      key: match.key,
      event: failureRequestEvent({
        tokenId: match.token.id,
        source: "api",
        httpStatus: 400,
        errorType: "invalid_request_error",
        errorMessage: "No user message content found",
        failureStage: "request",
        promptTokens,
        historyKey,
        latencyMs: Date.now() - requestStartedAt,
      }),
    });
    sendError(response, 400, "No user message content found");
    return;
  }

  const limitStatus = getTokenLimitStatus(match.token, match.accountState.usage || [], promptTokens);
  if (!limitStatus.allowed) {
    await saveRequestFailure({
      root,
      key: match.key,
      event: failureRequestEvent({
        tokenId: match.token.id,
        source: "api",
        httpStatus: 429,
        errorType: "rate_limit_exceeded",
        errorMessage: limitStatus.reasons.join("; "),
        failureStage: "limit_check",
        promptTokens,
        historyKey,
        latencyMs: Date.now() - requestStartedAt,
      }),
    });
    sendError(response, 429, limitStatus.reasons.join("; "), "rate_limit_exceeded");
    return;
  }

  const id = `chatcmpl_${Date.now()}_${randomName()}`;
  const model = body.model || apiModel;
  const client = casibaseClient(casibaseTarget);
  const account = match.token.account || match.accountState.account;
  response.setHeader("X-D-AI-History-Key", historyKey);
  response.setHeader("X-D-AI-Model", model);

  if (body.stream) {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    writeSse(response, openAiChunk({id, model, delta: {role: "assistant"}}));

    try {
      const turn = await runCasibaseTurn({
        client,
        account,
        historyKey,
        promptText,
        sessionCookie: match.accountState.sessionCookie,
        sharedStoreId,
        token: match.token,
      });
      let streamedText = "";

      streamedText = await readAnswer({
        client,
        answer: turn.answer,
        sessionCookie: match.accountState.sessionCookie,
        onText: (text) => {
          writeSse(response, openAiChunk({id, model, delta: {content: text}}));
        },
      });

      const finalMessages = await getMessages(client, turn.chat, match.accountState.sessionCookie);
      const usageRecord = buildUsageRecord({
        tokenId: match.token.id,
        historyKey,
        chat: turn.chat,
        messages: finalMessages,
        answerName: turn.answer.name,
        promptText,
        streamedText,
      });
      await saveUsage({root, key: match.key, tokenId: match.token.id, usageRecord});

      writeSse(response, openAiChunk({id, model, finishReason: "stop"}));
      writeSse(response, "[DONE]");
      response.end();
    } catch (error) {
      await saveRequestFailure({
        root,
        key: match.key,
        event: failureRequestEvent({
          tokenId: match.token.id,
          source: "api",
          httpStatus: 500,
          errorType: "server_error",
          errorMessage: error.message,
          failureStage: "stream",
          promptTokens,
          historyKey,
          latencyMs: Date.now() - requestStartedAt,
        }),
      });
      writeSse(response, JSON.stringify({error: {message: error.message, type: "server_error"}}));
      writeSse(response, "[DONE]");
      response.end();
    }

    return;
  }

  try {
    const turn = await runCasibaseTurn({
      client,
      account,
      historyKey,
      promptText,
      sessionCookie: match.accountState.sessionCookie,
      sharedStoreId,
      token: match.token,
    });
    const content = await readAnswer({
      client,
      answer: turn.answer,
      sessionCookie: match.accountState.sessionCookie,
    });
    const finalMessages = await getMessages(client, turn.chat, match.accountState.sessionCookie);
    const usageRecord = buildUsageRecord({
      tokenId: match.token.id,
      historyKey,
      chat: turn.chat,
      messages: finalMessages,
      answerName: turn.answer.name,
      promptText,
      streamedText: content,
    });
    await saveUsage({root, key: match.key, tokenId: match.token.id, usageRecord});

    sendJson(response, 200, completionResponse({id, model, content, usage: usageRecord}));
  } catch (error) {
    await saveRequestFailure({
      root,
      key: match.key,
      event: failureRequestEvent({
        tokenId: match.token.id,
        source: "api",
        httpStatus: 500,
        errorType: "server_error",
        errorMessage: error.message,
        failureStage: "casibase",
        promptTokens,
        historyKey,
        latencyMs: Date.now() - requestStartedAt,
      }),
    });
    sendError(response, 500, error.message, "server_error");
  }
}

function installMiddleware(server, options) {
  const root = options.root || process.cwd();
  const casibaseTarget = options.casibaseTarget;
  const casdoorTarget = options.casdoorTarget;
  const casdoorClientId = options.casdoorClientId;
  const casdoorClientSecret = options.casdoorClientSecret;
  const casdoorRedirectUri = options.casdoorRedirectUri;
  const sharedStoreId = options.sharedStoreId || "admin/ifm-v0";
  const uploadAdmin = options.uploadAdmin || {};

  server.middlewares.use(async (request, response, next) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (url.pathname === "/api/d-ai/token-state") {
        await syncTokenState({request, response, root, casibaseTarget});
        return;
      }

      if (url.pathname === "/api/d-ai/token-action") {
        await mutateTokenState({request, response, root, casibaseTarget});
        return;
      }

      if (url.pathname === "/api/d-ai/token-limit-check") {
        await checkTokenLimit({request, response, root, casibaseTarget});
        return;
      }

      if (url.pathname === "/api/d-ai/casdoor-token") {
        await exchangeCasdoorToken({
          request,
          response,
          casdoorTarget,
          casdoorClientId,
          casdoorClientSecret,
          casdoorRedirectUri,
        });
        return;
      }

      if (url.pathname === "/api/d-ai/upload-file") {
        await uploadChatFile({
          request,
          response,
          casibaseTarget,
          casdoorTarget,
          casdoorClientId,
          casdoorRedirectUri,
          sharedStoreId,
          uploadAdmin,
        });
        return;
      }

      if (url.pathname === "/api/v1/models") {
        await handleModels({request, response, root});
        return;
      }

      if (url.pathname === "/api/v1/histories") {
        await handleApiHistories({request, response, root});
        return;
      }

      if (url.pathname === "/api/v1/history") {
        await handleApiHistoryDetail({request, response, root, casibaseTarget});
        return;
      }

      if (url.pathname === "/api/v1/chat/completions") {
        await handleChatCompletions({request, response, root, casibaseTarget, sharedStoreId});
        return;
      }

      next();
    } catch (error) {
      sendError(response, 500, error.message, "server_error");
    }
  });
}

export function dAiApiPlugin(options) {
  return {
    name: "d-ai-api",
    configureServer(server) {
      installMiddleware(server, options);
    },
    configurePreviewServer(server) {
      installMiddleware(server, options);
    },
  };
}
