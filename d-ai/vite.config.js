import {defineConfig, loadEnv} from "vite";
import react from "@vitejs/plugin-react";
import {dAiApiPlugin} from "./server/daiApiPlugin.js";

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), "");
  const casdoorTarget = env.VITE_CASDOOR_TARGET || "http://casdoor.local:8000";
  const casibaseTarget = env.VITE_CASIBASE_TARGET || "http://casibase.local:14000";

  return {
    plugins: [react(), dAiApiPlugin({casibaseTarget})],
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
