import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { downloadSelectedAccounts, syncAccountPriorities } from "./api";
import type { AccountItem, QueryProgressEvent, RuntimeConfig } from "../types";

const demoConfig: RuntimeConfig = {
  cpaBaseUrl: "https://cpa.example/",
  managementKey: "example-management-key",
  backupPath: "D:\\backup\\codex",
  queryConcurrency: 3,
  priorityPlanOrder: ["team", "plus", "free", "pro 5x", "pro 20x", "unknown"],
};

const demoItems: AccountItem[] = [
  {
    name: "codex-a.json",
    email: "a@example.com",
    plan_type: "free",
    account_id: "acct-a",
    auth_index: "idx-a",
    priority: 99,
    remote_priority: 99,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
  },
  {
    name: "codex-b.json",
    email: "b@example.com",
    plan_type: "team",
    account_id: "acct-b",
    auth_index: "idx-b",
    priority: 80,
    remote_priority: 80,
    status: "unknown",
    windows: [],
    additional_windows: [],
    error: "",
    last_query_at: null,
  },
];

describe("api progress listeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    unlistenMock.mockReset();
    unlistenMock.mockResolvedValue(undefined);
  });

  it("downloadSelectedAccounts 只转发同一 requestId 的中间进度事件", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce(async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
      progressHandler = handler;
      return unlistenMock;
    });
    invokeMock.mockImplementationOnce(async (_command: string, payload: { requestId: string }) => {
      // 同一总线上的其他任务也会发事件，这里必须证明不会串到当前备份进度里。
      progressHandler?.({
        payload: { requestId: "other-request", completed: 7, total: 9, currentLabel: "skip-me" },
      });
      progressHandler?.({
        payload: { requestId: payload.requestId, completed: 1, total: 2, currentLabel: "codex-a.json" },
      });
      progressHandler?.({
        payload: { requestId: payload.requestId, completed: 2, total: 2, currentLabel: "codex-b.json" },
      });
      return [
        { name: "codex-a.json", destinationPath: "D:\\backup\\codex\\codex-a.json" },
        { name: "codex-b.json", destinationPath: "D:\\backup\\codex\\codex-b.json" },
      ];
    });

    const progressEvents: QueryProgressEvent[] = [];
    await downloadSelectedAccounts(demoConfig, demoItems, (event) => {
      progressEvents.push(event);
    });

    expect(progressEvents).toEqual([
      expect.objectContaining({ completed: 1, total: 2, currentLabel: "codex-a.json" }),
      expect.objectContaining({ completed: 2, total: 2, currentLabel: "codex-b.json" }),
    ]);
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("syncAccountPriorities 只接收属于本轮同步的 requestId 事件", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce(async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
      progressHandler = handler;
      return unlistenMock;
    });
    invokeMock.mockImplementationOnce(async (_command: string, payload: { requestId: string }) => {
      progressHandler?.({
        payload: { requestId: "other-request", completed: 5, total: 8, currentLabel: "skip-me" },
      });
      progressHandler?.({
        payload: {
          requestId: payload.requestId,
          completed: 1,
          total: 2,
          currentLabel: "codex-a.json",
        },
      });
      progressHandler?.({
        payload: {
          requestId: payload.requestId,
          completed: 2,
          total: 2,
          currentLabel: "codex-b.json",
        },
      });
    });

    const progressEvents: QueryProgressEvent[] = [];
    await syncAccountPriorities(
      demoConfig,
      [
        { name: "codex-a.json", priority: 99 },
        { name: "codex-b.json", priority: 80 },
      ],
      (event) => {
        progressEvents.push(event);
      },
    );

    expect(progressEvents).toEqual([
      expect.objectContaining({ completed: 1, total: 2, currentLabel: "codex-a.json" }),
      expect.objectContaining({ completed: 2, total: 2, currentLabel: "codex-b.json" }),
    ]);
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});
