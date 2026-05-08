import {defineConfig, loadEnv} from "vite";
import react from "@vitejs/plugin-react";
import {dAiApiPlugin} from "./server/daiApiPlugin.js";

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), "");
  const casdoorTarget = env.VITE_CASDOOR_TARGET || "http://casdoor.local:8000";
  const casibaseTarget = env.VITE_CASIBASE_TARGET || "http://casibase.local:14000";
  const sharedStoreId = env.VITE_CASIBASE_SHARED_STORE_ID || "admin/ifm-v0";
  const casdoorClientId = env.VITE_CASDOOR_CLIENT_ID || "ba3a96dbc430c5c6a22b";
  const casdoorClientSecret = env.VITE_CASDOOR_CLIENT_SECRET || "9228f4ce27971ca5c188cac7489dc0f304a122b6";
  const casdoorRedirectUri = env.VITE_CASDOOR_REDIRECT_URI || "http://casibase.local:14000/callback";
  const openMeter = {
    enabled: env.OPENMETER_ENABLED || "true",
    baseUrl: env.OPENMETER_BASE_URL || "http://localhost:48888",
    apiToken: env.OPENMETER_API_TOKEN || "",
    meterSlug: env.OPENMETER_METER_SLUG || "tokens_total",
    requestMeterSlug: env.OPENMETER_REQUEST_METER_SLUG || "requests_total",
    promptMeterSlug: env.OPENMETER_PROMPT_METER_SLUG || "prompt_tokens_total",
    completionMeterSlug: env.OPENMETER_COMPLETION_METER_SLUG || "completion_tokens_total",
    costMeterSlug: env.OPENMETER_COST_METER_SLUG || "cost_total",
    eventType: env.OPENMETER_EVENT_TYPE || "prompt",
    eventSource: env.OPENMETER_EVENT_SOURCE || "d-ai",
    subjectMode: env.OPENMETER_SUBJECT_MODE || "token",
    failClosed: env.OPENMETER_FAIL_CLOSED || "true",
    entitlementsEnabled: env.OPENMETER_ENTITLEMENTS_ENABLED || "true",
    totalTokensFeatureKey: env.OPENMETER_TOTAL_TOKENS_FEATURE_KEY || "d_ai_token_quota",
    requestsPerMinuteFeatureKey: env.OPENMETER_REQUESTS_PER_MINUTE_FEATURE_KEY || "d_ai_minute_requests",
    requestsPerHourFeatureKey: env.OPENMETER_REQUESTS_PER_HOUR_FEATURE_KEY || "d_ai_hourly_requests",
    tokensPerDayFeatureKey: env.OPENMETER_TOKENS_PER_DAY_FEATURE_KEY || "d_ai_daily_tokens",
    requestsPerDayFeatureKey: env.OPENMETER_REQUESTS_PER_DAY_FEATURE_KEY || "d_ai_daily_requests",
    totalTokensEntitlementPeriod: env.OPENMETER_TOTAL_TOKENS_ENTITLEMENT_PERIOD || "P100Y",
  };
  const auditLog = {
    enabled: env.D_AI_AUDIT_LOG_ENABLED || "true",
    filePath: env.D_AI_AUDIT_LOG_FILE || ".d-ai-state/logs/request-audit.jsonl",
  };
  const clickHouseLogs = {
    enabled: env.D_AI_CLICKHOUSE_LOGS_ENABLED || "true",
    baseUrl: env.D_AI_CLICKHOUSE_LOGS_URL || "http://localhost:18123",
    username: env.D_AI_CLICKHOUSE_LOGS_USERNAME || "default",
    password: env.D_AI_CLICKHOUSE_LOGS_PASSWORD || "default",
    database: env.D_AI_CLICKHOUSE_LOGS_DATABASE || "d_ai_logs",
    table: env.D_AI_CLICKHOUSE_LOGS_TABLE || "otel_logs",
  };
  const uploadAdmin = {
    organization: env.D_AI_UPLOAD_ADMIN_ORGANIZATION || env.VITE_D_AI_UPLOAD_ADMIN_ORGANIZATION || "built-in",
    username: env.D_AI_UPLOAD_ADMIN_USERNAME || env.VITE_D_AI_UPLOAD_ADMIN_USERNAME || "admin",
    password: env.D_AI_UPLOAD_ADMIN_PASSWORD || env.VITE_D_AI_UPLOAD_ADMIN_PASSWORD || "123",
  };

  return {
    plugins: [react(), dAiApiPlugin({
      casibaseTarget,
      casdoorTarget,
      casdoorClientId,
      casdoorClientSecret,
      casdoorRedirectUri,
      sharedStoreId,
      uploadAdmin,
      openMeter,
      auditLog,
      clickHouseLogs,
    })],
    server: {
      host: "0.0.0.0",
      port: Number(env.VITE_PORT || 5173),
      allowedHosts: ["casibase.local", "localhost", "127.0.0.1"],
      proxy: {
        "/casdoor": {
          target: casdoorTarget,
          changeOrigin: true,
          headers: {
            Origin: casdoorTarget,
          },
          rewrite: (path) => path.replace(/^\/casdoor/, ""),
        },
        "/casibase": {
          target: casibaseTarget,
          changeOrigin: true,
          headers: {
            Origin: casibaseTarget,
          },
          rewrite: (path) => path.replace(/^\/casibase/, ""),
        },
      },
    },
  };
});
