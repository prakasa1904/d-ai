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
