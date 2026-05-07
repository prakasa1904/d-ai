import fs from "node:fs/promises";
import path from "node:path";
import {
  estimateTokenCount,
  getTokenLimitStatus,
  normalizeTokenLimits,
} from "../src/tokens.js";

const apiModel = "d-ai-casibase";
const stateDirectory = ".d-ai-state";
const stateFilename = "tokens.json";

function now() {
  return new Date().toISOString();
}

function randomName() {
  return Math.random().toString(36).slice(2, 8);
}

function emptyTokenState() {
  return {
    version: 1,
    tokens: [],
    usage: [],
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
  };
}

function privateToken(token, account, sessionCookie) {
  return {
    ...normalizeToken(token),
    account: publicAccount(account),
    sessionCookie,
    updatedAt: now(),
  };
}

function publicToken(token) {
  const {account, sessionCookie, updatedAt, ...rest} = token;
  return rest;
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

async function syncTokenState({request, response, root}) {
  const body = await readJsonBody(request);
  const account = body.account;

  if (!account?.owner || !account?.name) {
    sendError(response, 400, "Missing account for token sync");
    return;
  }

  const incoming = normalizeState(body.state);
  const state = await loadServerState(root);
  const key = accountKey(account);
  const previous = state.accounts[key] || {};
  const sessionCookie = request.headers.cookie || previous.sessionCookie || "";
  const tokens = incoming.tokens.map((token) => privateToken(token, account, sessionCookie));
  const usage = mergeUsage(previous.usage, incoming.usage);

  state.accounts[key] = {
    account: publicAccount(account),
    sessionCookie,
    tokens,
    usage,
    updatedAt: now(),
  };

  await saveServerState(root, state);

  sendJson(response, 200, {
    status: "ok",
    data: {
      ...emptyTokenState(),
      tokens: tokens.map(publicToken),
      usage,
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

function promptFromOpenAiMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastUser = [...rows].reverse().find((message) => message?.role === "user") || rows.at(-1);
  return messageContentToText(lastUser?.content).trim();
}

async function chooseStore(client, sessionCookie, sharedStoreId) {
  const result = await client.get(`/api/get-store?id=${encodeURIComponent(sharedStoreId)}`, sessionCookie);
  return assertCasibaseOk(result, "Failed to load shared store").data || null;
}

async function createChat(client, account, store, sessionCookie) {
  const chatName = `chat_dai_api_${randomName()}`;
  const chat = {
    owner: "admin",
    name: chatName,
    store: store?.name || "",
    createdTime: now(),
    updatedTime: now(),
    organization: account.owner,
    displayName: `D-AI API - ${chatName.slice(-6)}`,
    category: "Default Category",
    type: "AI",
    user: account.name,
    user1: "",
    user2: "",
    users: [],
    clientIp: "",
    userAgent: "D-AI API",
    messageCount: 0,
    needTitle: true,
    modelProvider: store?.modelProvider || "",
    toolProvider: "",
  };

  assertCasibaseOk(await client.post("/api/add-chat", chat, sessionCookie), "Failed to create chat");
  return chat;
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

function buildUsageRecord({tokenId, chat, messages, answerName, promptText, streamedText}) {
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
    createdAt: now(),
    chatName: chat?.name || "",
    chatTitle: chat?.displayName || chat?.name || "",
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
  accountState.tokens = (accountState.tokens || []).map((token) => token.id === tokenId
    ? {...token, lastUsedAt: usageRecord.createdAt}
    : token);
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
  };
}

async function runCasibaseTurn({client, account, promptText, sessionCookie, sharedStoreId}) {
  const store = await chooseStore(client, sessionCookie, sharedStoreId);

  if (!store) {
    throw new Error("No Casibase store is available");
  }

  const chat = await createChat(client, account, store, sessionCookie);
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

  if (match.token.status !== "Active") {
    sendError(response, 401, "D-AI token is inactive", "authentication_error");
    return;
  }

  if (!match.accountState.sessionCookie) {
    sendError(response, 401, "Token is not synced with a signed-in browser session", "authentication_error");
    return;
  }

  const body = await readJsonBody(request);
  const promptText = promptFromOpenAiMessages(body.messages);
  if (!promptText) {
    sendError(response, 400, "No user message content found");
    return;
  }

  const limitStatus = getTokenLimitStatus(match.token, match.accountState.usage || [], estimateTokenCount(promptText));
  if (!limitStatus.allowed) {
    sendError(response, 429, limitStatus.reasons.join("; "), "rate_limit_exceeded");
    return;
  }

  const id = `chatcmpl_${Date.now()}_${randomName()}`;
  const model = body.model || apiModel;
  const client = casibaseClient(casibaseTarget);
  const account = match.token.account || match.accountState.account;

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
        promptText,
        sessionCookie: match.accountState.sessionCookie,
        sharedStoreId,
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
      writeSse(response, JSON.stringify({error: {message: error.message, type: "server_error"}}));
      writeSse(response, "[DONE]");
      response.end();
    }

    return;
  }

  const turn = await runCasibaseTurn({
    client,
    account,
    promptText,
    sessionCookie: match.accountState.sessionCookie,
    sharedStoreId,
  });
  const content = await readAnswer({
    client,
    answer: turn.answer,
    sessionCookie: match.accountState.sessionCookie,
  });
  const finalMessages = await getMessages(client, turn.chat, match.accountState.sessionCookie);
  const usageRecord = buildUsageRecord({
    tokenId: match.token.id,
    chat: turn.chat,
    messages: finalMessages,
    answerName: turn.answer.name,
    promptText,
    streamedText: content,
  });
  await saveUsage({root, key: match.key, tokenId: match.token.id, usageRecord});

  sendJson(response, 200, completionResponse({id, model, content, usage: usageRecord}));
}

function installMiddleware(server, options) {
  const root = options.root || process.cwd();
  const casibaseTarget = options.casibaseTarget;
  const casdoorTarget = options.casdoorTarget;
  const casdoorClientId = options.casdoorClientId;
  const casdoorClientSecret = options.casdoorClientSecret;
  const casdoorRedirectUri = options.casdoorRedirectUri;
  const sharedStoreId = options.sharedStoreId || "admin/store-built-in";

  server.middlewares.use(async (request, response, next) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (url.pathname === "/api/d-ai/token-state") {
        await syncTokenState({request, response, root});
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
