import { useEffect, useState } from "react";
import type { AccountItem } from "../types";

interface DetailPanelProps {
  item: AccountItem | null;
  onApplyPriority: (authIndex: string, priority: number) => void;
  onResetPriority: (authIndex: string) => void;
}

const STATUS_LABELS: Record<AccountItem["status"], string> = {
  healthy: "正常",
  low: "额度偏低",
  exhausted: "额度耗尽",
  error: "查询异常",
  unknown: "尚未查询",
};

function readPriorityInputValue(item: AccountItem | null): string {
  if (!item) {
    return "";
  }
  if (typeof item.draft_priority === "number") {
    return String(item.draft_priority);
  }
  if (typeof item.remote_priority === "number") {
    return String(item.remote_priority);
  }
  if (typeof item.priority === "number") {
    return String(item.priority);
  }
  return "";
}

function normalizePriorityInput(input: string): number | null {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

// 详情栏保留账号元信息，但去掉注释型标题，避免右侧信息层级过重。
export function DetailPanel({ item, onApplyPriority, onResetPriority }: DetailPanelProps) {
  const [priorityInput, setPriorityInput] = useState("");
  const parsedPriority = normalizePriorityInput(priorityInput);

  useEffect(() => {
    setPriorityInput(readPriorityInputValue(item));
  }, [item]);

  return (
    <aside className="detail-panel">
      <div className="detail-panel__header">
        <p className="detail-panel__anchor">当前账号</p>
        <h2>{item?.email || "等待选择账号"}</h2>
        {item ? <span className={`status-chip status-chip--${item.status}`}>{STATUS_LABELS[item.status]}</span> : null}
      </div>
      <section className="detail-panel__section">
        <p className="detail-panel__section-title">优先级</p>
        <dl className="detail-panel__grid">
          <div>
            <dt>远端值</dt>
            <dd>{item?.remote_priority ?? item?.priority ?? "-"}</dd>
          </div>
          <div>
            <dt>本地草稿</dt>
            <dd>{item?.draft_priority ?? item?.remote_priority ?? item?.priority ?? "-"}</dd>
          </div>
          <div>
            <dt>同步状态</dt>
            <dd>{item?.dirty_priority ? "未同步" : "已同步"}</dd>
          </div>
        </dl>
        <div className="priority-editor">
          <input
            aria-label="优先级输入框"
            type="number"
            min={0}
            step={1}
            value={priorityInput}
            disabled={!item}
            onChange={(event) => setPriorityInput(event.target.value)}
          />
          <div className="priority-editor__actions">
            <button
              type="button"
              className="command-button"
              disabled={!item || parsedPriority === null}
              onClick={() => {
                if (!item || parsedPriority === null) {
                  return;
                }
                // 空值和非法值不再偷偷写成 0，避免误把远端优先级覆盖成最低值。
                onApplyPriority(item.auth_index, parsedPriority);
              }}
            >
              应用到本地草稿
            </button>
            <button
              type="button"
              className="command-button"
              disabled={!item}
              onClick={() => {
                if (!item) {
                  return;
                }
                onResetPriority(item.auth_index);
              }}
            >
              恢复远端值
            </button>
          </div>
        </div>
      </section>
      <section className="detail-panel__section">
        <p className="detail-panel__section-title">基础信息</p>
        <dl className="detail-panel__grid">
          <div>
            <dt>文件名</dt>
            <dd>{item?.name || "-"}</dd>
          </div>
          <div>
            <dt>账号索引</dt>
            <dd>{item?.auth_index || "-"}</dd>
          </div>
          <div>
            <dt>账号 ID</dt>
            <dd>{item?.account_id || "-"}</dd>
          </div>
          <div>
            <dt>最近查询</dt>
            {/* 左侧主表已经展示分组、邮箱和额度窗口，这里只保留右侧独有的补充信息。 */}
            <dd>{item?.last_query_at || "-"}</dd>
          </div>
        </dl>
      </section>
      {item?.additional_windows.length ? (
        <div className="detail-panel__extra detail-panel__section">
          <p>附加窗口</p>
          <ul>
            {item.additional_windows.map((window) => (
              <li key={window.id}>
                <span>{window.label}</span>
                <strong>{window.remaining_percent === null ? "-" : `${Math.round(window.remaining_percent)}%`}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {item?.error ? (
        <div className="detail-panel__error detail-panel__section">
          <p>错误信息</p>
          <strong>{item.error}</strong>
        </div>
      ) : null}
    </aside>
  );
}
