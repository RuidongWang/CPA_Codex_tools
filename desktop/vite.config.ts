import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { WEB_SERVER_CONFIG } from "./web-server.config";

// 开发态和测试态共用同一份 Vite 配置，避免桌面壳和测试环境分叉。
export default defineConfig(({ command }) => ({
  // build 产物改成相对资源路径，dist/index.html 双击打开时不再把资源解析到 file:///assets。
  base: command === "build" ? "./" : "/",
  plugins: [react()],
  server: {
    host: WEB_SERVER_CONFIG.host,
    port: WEB_SERVER_CONFIG.devPort,
  },
  preview: {
    host: WEB_SERVER_CONFIG.host,
    port: WEB_SERVER_CONFIG.previewPort,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
  },
}));
