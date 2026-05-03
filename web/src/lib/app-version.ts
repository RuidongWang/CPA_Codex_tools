import packageMetadata from "../../package.json";

// Web 标题栏统一读取 package.json 版本，避免界面展示再手写一份。
export const APP_VERSION = packageMetadata.version;

// 标题栏只展示一个简洁标签，方便截图、排障和发布后快速核对当前构建版本。
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
