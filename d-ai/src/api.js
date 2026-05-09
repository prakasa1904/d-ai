import {authConfig, casdoorBase, casibaseBase, sharedStoreId} from "./config";

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
    throw new Error(payload?.msg || payload?.error?.message || `${response.status} ${response.statusText}`);
  }

  return payload;
}

async function apiGet(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: {"Accept-Language": "en", ...headers},
  });
  return readJson(response);
}

async function apiPost(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {...jsonHeaders, ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJson(response);
}

async function apiPostForm(base, path, formData) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {"Accept-Language": "en"},
    body: formData,
  });
  return readJson(response);
}

function assertOk(payload, fallback) {
  if (payload?.status !== "ok") {
    throw new Error(payload?.msg || fallback);
  }
  return payload;
}

export function hasCasdoorProfileToken(account) {
  return Boolean(account?.hasProfileAccess);
}

async function exchangeCasdoorToken(code) {
  const result = await apiPost("", "/api/d-ai/casdoor-token", {code});
  return assertOk(result, "Failed to exchange Casdoor token").data || {};
}

function authQuery(state) {
  return new URLSearchParams({
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
}

async function getCasdoorLoginCode(identity) {
  const state = `d-ai-${Date.now()}-${randomName()}`;
  const query = authQuery(state);

  const casdoorLogin = await apiPost(`${casdoorBase}`, `/api/login?${query.toString()}`, {
    username: identity.username,
    password: identity.password,
    organization: identity.organization,
    application: authConfig.application,
    signinMethod: "Password",
    type: "code",
    language: "",
  });

  assertOk(casdoorLogin, "Casdoor login failed");
  return {code: casdoorLogin.data, state};
}

async function signInCasibaseWithCode(code, state) {
  const signin = await apiPost(
    `${casibaseBase}`,
    `/api/signin?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );

  return assertOk(signin, "Casibase sign-in failed");
}

export async function refreshCasdoorProfileToken(account, password) {
  const result = await apiPost("", "/api/d-ai/profile-access", {
    owner: account?.owner,
    name: account?.name,
    password,
  });
  return assertOk(result, "Failed to authorize profile access").data;
}

export function resolveLoginIdentity(username) {
  const trimmedUsername = String(username || "").trim();
  const separatorIndex = trimmedUsername.indexOf("/");

  if (separatorIndex > 0 && separatorIndex < trimmedUsername.length - 1) {
    return {
      organization: authConfig.organization,
      username: trimmedUsername.slice(separatorIndex + 1).trim(),
    };
  }

  return {
    organization: authConfig.organization,
    username: trimmedUsername,
  };
}

export async function loginWithPassword(username, password) {
  const identity = {
    ...resolveLoginIdentity(username),
    password,
  };
  const signinCode = await getCasdoorLoginCode(identity);
  const result = await signInCasibaseWithCode(signinCode.code, signinCode.state);

  try {
    const profileCode = await getCasdoorLoginCode(identity);
    await exchangeCasdoorToken(profileCode.code);
  } catch {
    // Chat can still work without the Casdoor API token; profile save will explain the missing token.
  }

  return result;
}

export async function registerWithPassword({username, displayName, password}) {
  const identity = {
    ...resolveLoginIdentity(username),
    password,
  };
  const state = `d-ai-signup-${Date.now()}-${randomName()}`;
  const query = authQuery(state);
  const signup = await apiPost(`${casdoorBase}`, `/api/signup?${query.toString()}`, {
    username: identity.username,
    name: displayName || identity.username,
    password: identity.password,
    organization: identity.organization,
    application: authConfig.application,
    type: "code",
    language: "",
  });
  const signupCode = assertOk(signup, "Casdoor registration failed").data;

  if (!signupCode) {
    throw new Error("Casdoor registration did not return a sign-in code.");
  }

  const result = await signInCasibaseWithCode(signupCode, state);

  try {
    const profileCode = await getCasdoorLoginCode(identity);
    await exchangeCasdoorToken(profileCode.code);
  } catch {
    // Chat can still work without the Casdoor API token; profile save will explain the missing token.
  }

  return result;
}

export async function getAccount() {
  return assertOk(await apiGet(casibaseBase, "/api/get-account"), "Please sign in first").data;
}

export async function getUserProfile(account) {
  return assertOk(await apiGet("", "/api/d-ai/profile"), "Failed to load user profile").data || account;
}

export async function updateUserProfile(profile, updates) {
  const result = await apiPost("", "/api/d-ai/profile", {profile, updates});
  return assertOk(result, "Failed to update user profile").data || profile;
}

export async function signOut() {
  await apiPost(casibaseBase, "/api/signout").catch(() => null);
  await apiPost(casdoorBase, "/api/logout").catch(() => null);
}

export async function getServerTokenState() {
  const result = await apiGet("", "/api/d-ai/token-state");
  return assertOk(result, "Failed to load token state").data;
}

export async function mutateTokenState(action, payload = {}) {
  const result = await apiPost("", "/api/d-ai/token-action", {action, ...payload});
  return assertOk(result, "Failed to update token state").data;
}

export async function checkTokenLimit({tokenId, promptText, pendingTokens}) {
  const result = await apiPost("", "/api/d-ai/token-limit-check", {tokenId, promptText, pendingTokens});
  return assertOk(result, "Token limit exceeded").data;
}

export async function getTokenMetrics({periodDays = 7, tokenId = "all"} = {}) {
  const query = new URLSearchParams({
    periodDays: String(periodDays),
    tokenId: tokenId || "all",
  });
  const result = await apiGet("", `/api/d-ai/token-metrics?${query.toString()}`);
  return assertOk(result, "Failed to load token metrics").data;
}

export async function getTokenRequestLogs({periodDays = 7, tokenId = "all", limit = 500} = {}) {
  const query = new URLSearchParams({
    periodDays: String(periodDays),
    tokenId: tokenId || "all",
    limit: String(limit),
  });
  const result = await apiGet("", `/api/d-ai/token-request-logs?${query.toString()}`);
  return assertOk(result, "Failed to load token request logs").data;
}

export async function getStores() {
  const result = await apiGet(casibaseBase, `/api/get-store?id=${encodeURIComponent(sharedStoreId)}`);
  const store = assertOk(result, "Failed to load shared store").data;

  if (!store) {
    throw new Error(`Shared store ${sharedStoreId} was not found. Update VITE_CASIBASE_SHARED_STORE_ID or restore the Casibase store name.`);
  }

  return [store];
}

export async function getStoreFiles(store) {
  const owner = store?.owner || "admin";
  const storeName = store?.name || "";
  const query = new URLSearchParams({owner, store: storeName});
  const result = await apiGet(casibaseBase, `/api/get-files?${query.toString()}`);
  return assertOk(result, "Failed to load store files").data || [];
}

export async function uploadStoreFile({store, file, key = ""}) {
  if (!store?.name) {
    throw new Error("Choose a store before uploading a file.");
  }

  if (!file) {
    throw new Error("Choose a file before uploading.");
  }

  const storeId = `${store.owner || "admin"}/${store.name}`;
  const trimmedKey = String(key || "").replace(/^\/+|\/+$/g, "");
  const formData = new FormData();
  formData.append("file", file, file.name);
  formData.append("storeId", storeId);
  formData.append("key", trimmedKey);
  formData.append("filename", file.name);

  const result = await apiPostForm("", "/api/d-ai/upload-file", formData);
  return assertOk(result, "Failed to upload file").data;
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

export async function deleteChat(chat) {
  assertOk(await apiPost(casibaseBase, "/api/delete-chat", chat), "Failed to delete chat");
}

export async function updateChat(chat) {
  const id = `${chat.owner}/${chat.name}`;
  assertOk(await apiPost(casibaseBase, `/api/update-chat?id=${encodeURIComponent(id)}`, chat), "Failed to update chat");
  return chat;
}

export async function updateMessage(message) {
  const id = `${message.owner}/${message.name}`;
  assertOk(await apiPost(casibaseBase, `/api/update-message?id=${encodeURIComponent(id)}`, message), "Failed to update message");
  return message;
}

export async function sendChatMessage({account, chat, store, text, attachments = []}) {
  const modelProvider = store?.modelProvider || chat.modelProvider || "";
  const storeName = store?.name || chat.store || "";
  let activeChat = chat;
  const fileName = attachments
    .map((item) => item.filename || item.objectKey || "")
    .filter(Boolean)
    .join(", ")
    .slice(0, 100);

  if ((modelProvider && chat.modelProvider !== modelProvider) || (storeName && chat.store !== storeName)) {
    activeChat = {
      ...chat,
      store: storeName,
      modelProvider,
      updatedTime: now(),
    };
    await updateChat(activeChat);
  }

  const message = {
    owner: "admin",
    name: `message_dai_${randomName()}`,
    createdTime: now(),
    organization: account.owner,
    store: storeName,
    user: account.name,
    chat: activeChat.name,
    replyTo: "",
    author: account.name,
    text,
    isHidden: false,
    isDeleted: false,
    isAlerted: false,
    isRegenerated: false,
    fileName,
    webSearchEnabled: false,
    modelProvider,
  };

  const result = await apiPost(casibaseBase, "/api/add-message", message);
  const updatedChat = assertOk(result, "Failed to send message").data || activeChat;
  return {
    ...updatedChat,
    store: storeName,
    modelProvider,
  };
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
