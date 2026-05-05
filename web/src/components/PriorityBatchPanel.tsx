import { useEffect, useMemo, useState } from "react";
import {
  buildPriorityPlanPreview,
  labelPriorityPlan,
  movePriorityPlanOrder,
  normalizePriorityPlanOrder,
  normalizePriorityPlanSelection,
} from "../lib/priority";
import type { PriorityPlanKey } from "../types";

interface PriorityBatchPanelProps {
  open: boolean;
  priorityCounts: Array<{ key: PriorityPlanKey; count: number }>;
  priorityPlanOrder: PriorityPlanKey[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (result: { selectedGroups: PriorityPlanKey[]; priorityPlanOrder: PriorityPlanKey[] }) => void;
}

function buildDefaultSelection(priorityCounts: Array<{ key: PriorityPlanKey; count: number }>): PriorityPlanKey[] {
  return normalizePriorityPlanSelection(priorityCounts.filter((entry) => entry.count > 0).map((entry) => entry.key));
}

function buildRangeLabel(range: { minPriority: number | null; maxPriority: number | null }, checked: boolean): string {
  if (!checked) {
    return "不调整";
  }
  if (range.maxPriority === null || range.minPriority === null) {
    return "-";
  }
  // 区间文案统一按低到高展示，便于快速判断最终落点。
  return `${range.minPriority} - ${range.maxPriority}`;
}

// 批量优先级弹层只负责收集选择结果，具体草稿生成继续交给外层状态编排。
export function PriorityBatchPanel(props: PriorityBatchPanelProps) {
  const [selectedGroups, setSelectedGroups] = useState<PriorityPlanKey[]>(() => buildDefaultSelection(props.priorityCounts));
  const [draftOrder, setDraftOrder] = useState<PriorityPlanKey[]>(() => normalizePriorityPlanOrder(props.priorityPlanOrder));

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setSelectedGroups(buildDefaultSelection(props.priorityCounts));
    setDraftOrder(normalizePriorityPlanOrder(props.priorityPlanOrder));
  }, [props.open, props.priorityCounts, props.priorityPlanOrder]);

  const preview = useMemo(
    () => buildPriorityPlanPreview(props.priorityCounts, draftOrder, selectedGroups),
    [draftOrder, props.priorityCounts, selectedGroups],
  );

  if (!props.open) {
    return null;
  }

  return (
    <div className="settings-dialog__backdrop" role="presentation">
      <section className="settings-dialog settings-dialog--priority" role="dialog" aria-modal="true" aria-label="批量设置优先级">
        <header className="settings-dialog__header">
          <div>
            <h2>批量设置优先级</h2>
          </div>
          <button type="button" className="settings-dialog__ghost" onClick={props.onClose} disabled={props.saving}>
            关闭
          </button>
        </header>
        <div className="settings-dialog__body">
          <section className="settings-section" aria-label="作用范围">
            <div className="settings-section__header">
              <h3>作用范围</h3>
            </div>
            <div className="priority-order-grid">
              {preview.map((entry, index) => {
                const checked = selectedGroups.includes(entry.key);
                const rangeLabel = buildRangeLabel(entry, checked);

                return (
                  <article key={entry.key} className={`priority-order-card${checked ? " priority-order-card--active" : ""}`}>
                    <div className="priority-order-card__topline">
                      <label className="priority-order-card__header">
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`调整 ${labelPriorityPlan(entry.key)}`}
                          onChange={(event) =>
                            setSelectedGroups((current) => {
                              if (event.target.checked) {
                                return normalizePriorityPlanSelection([...current, entry.key]);
                              }
                              return current.filter((item) => item !== entry.key);
                            })
                          }
                        />
                        <strong>{labelPriorityPlan(entry.key)}</strong>
                      </label>
                      <span className="priority-order-card__count">{entry.count} 个</span>
                    </div>
                    <div className="priority-order-card__meta">
                      <span className="priority-order-card__range-label">区间</span>
                      <strong>{rangeLabel}</strong>
                    </div>
                    <div className="priority-order-card__actions">
                      <button
                        type="button"
                        className="command-button"
                        aria-label={`左移 ${labelPriorityPlan(entry.key)}`}
                        onClick={() => setDraftOrder((current) => movePriorityPlanOrder(current, index, -1))}
                        disabled={index === 0 || props.saving}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        className="command-button"
                        aria-label={`右移 ${labelPriorityPlan(entry.key)}`}
                        onClick={() => setDraftOrder((current) => movePriorityPlanOrder(current, index, 1))}
                        disabled={index === preview.length - 1 || props.saving}
                      >
                        →
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="settings-section__hint">
              <span>按当前账号列表顺序在分组内从高到低生成，只会改动勾选分组。</span>
            </div>
          </section>
        </div>
        <footer className="settings-dialog__footer">
          <button type="button" className="command-button" onClick={props.onClose} disabled={props.saving}>
            取消
          </button>
          <button
            type="button"
            className="command-button command-button--primary"
            onClick={() =>
              props.onSubmit({
                selectedGroups,
                priorityPlanOrder: draftOrder,
              })
            }
            disabled={props.saving || selectedGroups.length === 0}
          >
            {props.saving ? "生成中" : "生成本地草稿"}
          </button>
        </footer>
      </section>
    </div>
  );
}
