// 纯 Web 运行时端口集中放在这里改，避免 npm script、Vite 配置和文档各写一份。
export const WEB_SERVER_CONFIG = {
  host: "127.0.0.1",
  devPort: 5173,
  previewPort: 9999,
} as const;
