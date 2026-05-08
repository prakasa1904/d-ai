import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function now() {
  return new Date().toISOString();
}

function stableHash(value) {
  if (!value) {
    return "";
  }

  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function textValue(value, maxLength = 500) {
  return String(value || "").slice(0, maxLength);
}

function auditRecord({token, account, event = {}, usageRecord = {}, endpoint = "/api/v1/chat/completions", method = "POST"}) {
  const createdAt = event.createdAt || usageRecord.createdAt || now();
  const status = event.status || "success";
  const httpStatus = numberValue(event.httpStatus || (status === "success" ? 200 : 500));
  const historyKey = event.historyKey || usageRecord.historyKey || "";

  return {
    timestamp: createdAt,
    request_id: event.id || usageRecord.id || `req_${Date.now()}`,
    account_owner: account?.owner || token?.account?.owner || "",
    account_name: account?.name || token?.account?.name || "",
    token_id: token?.id || event.tokenId || usageRecord.tokenId || "",
    token_name: token?.name || "",
    source: event.source || "api",
    endpoint,
    method,
    status,
    http_status: httpStatus,
    error_type: textValue(event.errorType, 120),
    error_message: textValue(event.errorMessage, 500),
    failure_stage: textValue(event.failureStage, 120),
    model_provider: event.modelProvider || usageRecord.modelProvider || "",
    history_key_hash: stableHash(historyKey),
    chat_name: event.chatName || usageRecord.chatName || "",
    prompt_tokens: numberValue(event.promptTokens ?? usageRecord.promptTokens),
    completion_tokens: numberValue(event.responseTokens ?? usageRecord.responseTokens),
    total_tokens: numberValue(event.totalTokens ?? usageRecord.totalTokens),
    price: numberValue(usageRecord.price),
    currency: usageRecord.currency || "",
    latency_ms: numberValue(event.latencyMs),
  };
}

export function createAuditLogger(options = {}) {
  const enabled = normalizeBoolean(options.enabled, true);
  const root = options.root || process.cwd();
  const filePath = path.isAbsolute(options.filePath || "")
    ? options.filePath
    : path.join(root, options.filePath || ".d-ai-state/logs/request-audit.jsonl");

  async function append(record) {
    if (!enabled) {
      return {status: "skipped", reason: "audit_log_disabled"};
    }

    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`);
    return {status: "ok", filePath};
  }

  return {
    enabled,
    filePath,
    recordRequest(payload) {
      return append(auditRecord(payload));
    },
  };
}
