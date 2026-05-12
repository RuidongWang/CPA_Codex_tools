import { createContext, useContext, type ReactNode } from "react";
import type { AppLanguage } from "../types";

const ZH = {
  "app.title": "Codex 额度监控台",
  "window.logout": "退出登录",
  "window.settings": "打开设置",
  "sidebar.nav": "页面导航",
  "sidebar.quota": "额度",
  "sidebar.config": "配置",
  "sidebar.keeper": "Keeper",
  "sidebar.oauth": "OAuth",
  "sidebar.quotaAria": "额度页面",
  "sidebar.configAria": "配置页面",
  "sidebar.keeperAria": "Keeper页面",
  "sidebar.oauthAria": "Codex OAuth登录页面",
  "toolbar.console": "操作台",
  "toolbar.currentViewAll": "当前视图 全部状态",
  "toolbar.currentView": "当前视图 {status}",
  "toolbar.lastUpdated": "最近更新 {time}",
  "toolbar.notQueried": "尚未查询",
  "toolbar.loadAccounts": "加载账号",
  "toolbar.querySelected": "查询选中账号 ({count})",
  "toolbar.querying": "查询中",
  "toolbar.batchPriority": "批量设置优先级",
  "toolbar.clearDrafts": "清除本地草稿",
  "toolbar.downloadAll": "下载所有账号",
  "toolbar.downloadSelected": "下载选中 ({count})",
  "toolbar.downloading": "下载中",
  "toolbar.sync": "同步到远端",
  "toolbar.syncing": "同步中",
  "toolbar.busyQuery": "正在查询选中的账号",
  "toolbar.busyDownload": "正在下载远端账号",
  "toolbar.busySync": "正在同步优先级",
  "toolbar.busyKeeper": "正在执行 Keeper 维护",
  "toolbar.busyList": "正在加载账号列表",
  "toolbar.idle": "空闲",
  "status.all": "全部状态",
  "status.healthy": "正常",
  "status.low": "偏低",
  "status.exhausted": "耗尽",
  "status.error": "异常",
  "status.unknown": "未查",
  "plan.nav": "计划筛选",
  "plan.all": "全部",
  "plan.unknown": "未知",
  "plan.search": "按邮箱搜索",
  "overview.label": "总览",
  "overview.all": "账号总数",
  "overview.healthy": "状态正常",
  "overview.low": "额度偏低",
  "overview.exhausted": "额度耗尽",
  "overview.error": "查询异常",
  "overview.unknown": "未查询账号",
  "settings.title": "查询设置",
  "settings.close": "关闭",
  "settings.hint": "账号配置备份会通过浏览器直接下载 JSON 文件，不需要配置本地路径。",
  "settings.uiSection": "界面",
  "settings.themeMode": "页面模式",
  "settings.themeSystem": "跟随系统",
  "settings.themeLight": "亮色",
  "settings.themeDark": "暗色",
  "settings.language": "语言",
  "settings.languageZh": "中文",
  "settings.languageEn": "English",
  "settings.concurrency": "并发数",
  "settings.keeperSection": "Keeper 策略",
  "settings.quotaThreshold": "禁用阈值",
  "settings.expiryThresholdDays": "过期阈值天数",
  "settings.workerThreads": "维护并发数",
  "settings.enableRefresh": "维护时自动刷新临期证书",
  "settings.localData": "本地数据",
  "settings.cacheHint": "会删除浏览器里保存的 CPA 地址、管理密钥、账号列表缓存和额度快照。",
  "settings.exportSensitive": "导出敏感配置",
  "settings.clearCache": "清空本地缓存",
  "settings.clearing": "清理中",
  "settings.cancel": "取消",
  "settings.save": "保存设置",
  "settings.saving": "保存中",
  "login.page": "登录页面",
  "login.form": "登录表单",
  "login.title": "登录 Codex 额度监控台",
  "login.baseUrl": "CPA 管理地址",
  "login.key": "管理密钥",
  "login.keyPlaceholder": "输入管理密钥",
  "login.showKey": "显示管理密钥",
  "login.hideKey": "隐藏管理密钥",
  "login.remember": "记住本次登录",
  "login.submit": "登录",
  "login.connecting": "连接中",
  "login.checking": "恢复登录中",
} as const;

const EN: Record<keyof typeof ZH, string> = {
  "app.title": "Codex Quota Console",
  "window.logout": "Log Out",
  "window.settings": "Open Settings",
  "sidebar.nav": "Page Navigation",
  "sidebar.quota": "Quota",
  "sidebar.config": "Config",
  "sidebar.keeper": "Keeper",
  "sidebar.oauth": "OAuth",
  "sidebar.quotaAria": "Quota page",
  "sidebar.configAria": "Config page",
  "sidebar.keeperAria": "Keeper page",
  "sidebar.oauthAria": "Codex OAuth login page",
  "toolbar.console": "Console",
  "toolbar.currentViewAll": "Current view All statuses",
  "toolbar.currentView": "Current view {status}",
  "toolbar.lastUpdated": "Last updated {time}",
  "toolbar.notQueried": "Not queried",
  "toolbar.loadAccounts": "Load Accounts",
  "toolbar.querySelected": "Query Selected ({count})",
  "toolbar.querying": "Querying",
  "toolbar.batchPriority": "Batch Priority",
  "toolbar.clearDrafts": "Clear Drafts",
  "toolbar.downloadAll": "Download All",
  "toolbar.downloadSelected": "Download Selected ({count})",
  "toolbar.downloading": "Downloading",
  "toolbar.sync": "Sync Remote",
  "toolbar.syncing": "Syncing",
  "toolbar.busyQuery": "Querying selected accounts",
  "toolbar.busyDownload": "Downloading remote accounts",
  "toolbar.busySync": "Syncing priorities",
  "toolbar.busyKeeper": "Running Keeper maintenance",
  "toolbar.busyList": "Loading account list",
  "toolbar.idle": "Idle",
  "status.all": "All statuses",
  "status.healthy": "Healthy",
  "status.low": "Low",
  "status.exhausted": "Exhausted",
  "status.error": "Error",
  "status.unknown": "Unknown",
  "plan.nav": "Plan Filter",
  "plan.all": "All",
  "plan.unknown": "Unknown",
  "plan.search": "Search by email",
  "overview.label": "Overview",
  "overview.all": "Total Accounts",
  "overview.healthy": "Healthy",
  "overview.low": "Low Quota",
  "overview.exhausted": "Exhausted",
  "overview.error": "Query Errors",
  "overview.unknown": "Unqueried",
  "settings.title": "Query Settings",
  "settings.close": "Close",
  "settings.hint": "Account config backups download JSON files directly from the browser. No local path is required.",
  "settings.uiSection": "Interface",
  "settings.themeMode": "Page Mode",
  "settings.themeSystem": "System",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "settings.languageZh": "中文",
  "settings.languageEn": "English",
  "settings.concurrency": "Concurrency",
  "settings.keeperSection": "Keeper Policy",
  "settings.quotaThreshold": "Disable Threshold",
  "settings.expiryThresholdDays": "Expiry Threshold Days",
  "settings.workerThreads": "Maintenance Threads",
  "settings.enableRefresh": "Auto refresh expiring certificates during maintenance",
  "settings.localData": "Local Data",
  "settings.cacheHint": "This removes the CPA URL, management key, account cache, and quota snapshots stored in the browser.",
  "settings.exportSensitive": "Export Sensitive Config",
  "settings.clearCache": "Clear Local Cache",
  "settings.clearing": "Clearing",
  "settings.cancel": "Cancel",
  "settings.save": "Save Settings",
  "settings.saving": "Saving",
  "login.page": "Login Page",
  "login.form": "Login Form",
  "login.title": "Log In to Codex Quota Console",
  "login.baseUrl": "CPA Management URL",
  "login.key": "Management Key",
  "login.keyPlaceholder": "Enter management key",
  "login.showKey": "Show management key",
  "login.hideKey": "Hide management key",
  "login.remember": "Remember this login",
  "login.submit": "Log In",
  "login.connecting": "Connecting",
  "login.checking": "Restoring login",
};

export type I18nKey = keyof typeof ZH;

const DICTIONARIES: Record<AppLanguage, Record<I18nKey, string>> = {
  zh: ZH,
  en: EN,
};

interface I18nContextValue {
  language: AppLanguage;
  t: (key: I18nKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: "zh",
  t: (key, values) => formatMessage(DICTIONARIES.zh[key], values),
});

function formatMessage(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function translate(language: AppLanguage, key: I18nKey, values?: Record<string, string | number>): string {
  return formatMessage(DICTIONARIES[language][key] ?? DICTIONARIES.zh[key], values);
}

export function I18nProvider({ language, children }: { language: AppLanguage; children: ReactNode }) {
  const normalizedLanguage: AppLanguage = language === "en" ? "en" : "zh";
  return (
    <I18nContext.Provider
      value={{
        language: normalizedLanguage,
        t: (key, values) => translate(normalizedLanguage, key, values),
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
