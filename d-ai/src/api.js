import {authConfig, casdoorBase, casibaseBase} from "./config";

const jsonHeaders = {
  "Accept-Language": "en",
  "Content-Type": "text/plain;charset=UTF-8",
};

function randomName() {
  return Math.random().toString(36).slice(2, 8);
}

function now() {
  return new Date().toISOString();
}

async function readJson(response) {
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 160)}`);
  }

  if (!response.ok) {
    throw new Error(payload?.msg || `${response.status} ${response.statusText}`);
  }

  return payload;
}

async function apiGet(base, path) {
  const response = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: {"Accept-Language": "en"},
  });
  return readJson(response);
}

async function apiPost(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJson(response);
}

function assertOk(payload, fallback) {
  if (payload?.status !== "ok") {
    throw new Error(payload?.msg || fallback);
  }
  return payload;
}

export async function loginWithPassword(username, password) {
  const state = `d-ai-${Date.now()}-${randomName()}`;
  const query = new URLSearchParams({
    clientId: authConfig.clientId,
    responseType: "code",
    redirectUri: authConfig.redirectUri,
    type: "code",
    scope: authConfig.scope,
    state,
    nonce: "",
    code_challenge_method: "",
    code_challenge: "",
  });

  const casdoorLogin = await apiPost(`${casdoorBase}`, `/api/login?${query.toString()}`, {
    username,
    password,
    organization: authConfig.organization,
    application: authConfig.application,
    signinMethod: "Password",
    type: "code",
    language: "",
  });

  assertOk(casdoorLogin, "Casdoor login failed");

  const signin = await apiPost(
    `${casibaseBase}`,
    `/api/signin?code=${encodeURIComponent(casdoorLogin.data)}&state=${encodeURIComponent(state)}`,
  );

  return assertOk(signin, "Casibase sign-in failed");
}

export async function getAccount() {
  return assertOk(await apiGet(casibaseBase, "/api/get-account"), "Please sign in first").data;
}

export async function signOut() {
  await apiPost(casibaseBase, "/api/signout").catch(() => null);
  await apiPost(casdoorBase, "/api/logout").catch(() => null);
}

export async function getStores() {
  const result = await apiGet(casibaseBase, "/api/get-stores?owner=admin");
  return assertOk(result, "Failed to load stores").data || [];
}

export async function getChats(account) {
  const query = new URLSearchParams({
    user: account.name,
    selectedUser: "",
    store: "",
    p: "-1",
    pageSize: "-1",
    field: "user",
    value: account.name,
    sortField: "",
    sortOrder: "",
    startTime: "",
    endTime: "",
  });

  const result = await apiGet(casibaseBase, `/api/get-chats?${query.toString()}`);
  return assertOk(result, "Failed to load chat history").data || [];
}

export function chooseStore(stores) {
  return stores.find((store) => store.isDefault) || stores[0] || null;
}

export async function createChat({account, store}) {
  const chatName = `chat_dai_${randomName()}`;
  const chat = {
    owner: "admin",
    name: chatName,
    store: store?.name || "",
    createdTime: now(),
    updatedTime: now(),
    organization: account.owner,
    displayName: `D-AI Chat - ${chatName.slice(-6)}`,
    category: "Default Category",
    type: "AI",
    user: account.name,
    user1: "",
    user2: "",
    users: [],
    clientIp: account.createdIp || "",
    userAgent: account.education || "",
    messageCount: 0,
    needTitle: true,
    modelProvider: store?.modelProvider || "",
    toolProvider: "",
  };

  assertOk(await apiPost(casibaseBase, "/api/add-chat", chat), "Failed to create chat");
  return chat;
}

export async function sendChatMessage({account, chat, store, text}) {
  const message = {
    owner: "admin",
    name: `message_dai_${randomName()}`,
    createdTime: now(),
    organization: account.owner,
    store: chat.store || store?.name || "",
    user: account.name,
    chat: chat.name,
    replyTo: "",
    author: account.name,
    text,
    isHidden: false,
    isDeleted: false,
    isAlerted: false,
    isRegenerated: false,
    fileName: "",
    webSearchEnabled: false,
    modelProvider: chat.modelProvider || store?.modelProvider || "",
  };

  const result = await apiPost(casibaseBase, "/api/add-message", message);
  return assertOk(result, "Failed to send message").data || chat;
}

export async function getMessages(chat) {
  const result = await apiGet(casibaseBase, `/api/get-messages?owner=admin&chat=${encodeURIComponent(chat.name)}`);
  return assertOk(result, "Failed to load messages").data || [];
}

export function openAnswerStream({message, onText, onReason, onEnd, onError}) {
  const url = `${casibaseBase}/api/get-message-answer?id=${message.owner}/${encodeURIComponent(message.name)}`;
  const source = new EventSource(url, {withCredentials: true});

  source.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      onText(payload.text || "");
    } catch (error) {
      onError(error);
      source.close();
    }
  });

  source.addEventListener("reason", (event) => {
    try {
      const payload = JSON.parse(event.data);
      onReason(payload.text || "");
    } catch {
      onReason("");
    }
  });

  source.addEventListener("myerror", (event) => {
    onError(new Error(event.data || "Casibase stream failed"));
    source.close();
  });

  source.addEventListener("error", () => {
    onError(new Error("Casibase stream connection closed unexpectedly"));
    source.close();
  });

  source.addEventListener("end", () => {
    onEnd();
    source.close();
  });

  return () => source.close();
}
