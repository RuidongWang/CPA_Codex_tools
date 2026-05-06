import { useEffect, useMemo, useState } from "react";
import {
  buildPriorityPlanPreview,
  labelPriorityPlan,
  movePriorityPlanOrder,
  normalizePriorityPlanRange,
  normalizePriorityPlanOrder,
  normalizePriorityPlanRanges,
  normalizePriorityPlanSelection,
} from "../lib/priority";
import type { PriorityPlanKey, PriorityPlanRange, PriorityPlanRangeMap } from "../types";

interface PriorityBatchPanelProps {
  open: boolean;
  priorityCounts: Array<{ key: PriorityPlanKey; count: number }>;
  priorityPlanOrder: PriorityPlanKey[];
  priorityPlanRanges?: PriorityPlanRangeMap;
  saving: boolean;
  onClose: () => void;
  onSubmit: (result: {
    selectedGroups: PriorityPlanKey[];
    priorityPlanOrder: PriorityPlanKey[];
    priorityPlanRanges: PriorityPlanRangeMap;
  }) => void;
}

type DraftRangeMap = Partial<Record<PriorityPlanKey, { minPriority: string; maxPriority: string }>>;

function buildDefaultSelection(priorityCounts: Array<{ key: PriorityPlanKey; count: number }>): PriorityPlanKey[] {
  return normalizePriorityPlanSelection(priorityCounts.filter((entry) => entry.count > 0).map((entry) => entry.key));
}

function toDraftRange(range: PriorityPlanRange): { minPriority: string; maxPriority: string } {
  return {
    minPriority: String(range.minPriority),
    maxPriority: String(range.maxPriority),
  };
}

function parseDraftRange(range: { minPriority: string; maxPriority: string } | undefined): PriorityPlanRange | null {
  if (!range) {
    return null;
  }
  const parsed = normalizePriorityPlanRange({
    minPriority: range.minPriority,
    maxPriority: range.maxPriority,
  });
  if (!parsed) {
    return null;
  }
  const rawMin = Number.parseInt(range.minPriority, 10);
  const rawMax = Number.parseInt(range.maxPriority, 10);
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMin > rawMax) {
    return null;
  }
  return parsed;
}

function buildInitialRanges(
  priorityCounts: Array<{ key: PriorityPlanKey; count: number }>,
  priorityPlanOrder: PriorityPlanKey[],
  selectedGroups: PriorityPlanKey[],
  savedRanges: PriorityPlanRangeMap,
): DraftRangeMap {
  const normalizedSavedRanges = normalizePriorityPlanRanges(savedRanges);
  const preview = buildPriorityPlanPreview(priorityCounts, priorityPlanOrder, selectedGroups);
  const ranges: DraftRangeMap = {};
  for (const entry of preview) {
    const savedRange = normalizedSavedRanges[entry.key];
    if (savedRange) {
      ranges[entry.key] = toDraftRange(savedRange);
      continue;
    }
    if (entry.minPriority !== null && entry.maxPriority !== null) {
      ranges[entry.key] = toDraftRange({ minPriority: entry.minPriority, maxPriority: entry.maxPriority });
    }
  }
  return ranges;
}

function buildSubmittedRanges(ranges: DraftRangeMap): PriorityPlanRangeMap {
  const submitted: PriorityPlanRangeMap = {};
  for (const [key, range] of Object.entries(ranges) as Array<[PriorityPlanKey, DraftRangeMap[PriorityPlanKey]]>) {
    const parsed = parseDraftRange(range);
    if (parsed) {
      submitted[key] = parsed;
    }
  }
  return submitted;
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

function buildBucketSummary(count: number, range: PriorityPlanRange | null, checked: boolean): string {
  if (!checked) {
    return "不调整";
  }
  if (!range) {
    return "区间需从小到大";
  }
  if (count <= 0) {
    return "无账号";
  }
  const tierCount = range.maxPriority - range.minPriority + 1;
  if (tierCount === 1) {
    return `1档 · 全部设为${range.maxPriority}`;
  }
  if (count < tierCount) {
    return `${tierCount}档 · 使用前${count}档`;
  }
  const groupSize = Math.floor(count / tierCount);
  const remainder = count % tierCount;
  return remainder > 0
    ? `${tierCount}档 · 每档${groupSize}个 · 余${remainder}个归最后档`
    : `${tierCount}档 · 每档${groupSize}个`;
}

// 批量优先级弹层只负责收集选择结果，具体草稿生成继续交给外层状态编排。
export function PriorityBatchPanel(props: PriorityBatchPanelProps) {
  const [selectedGroups, setSelectedGroups] = useState<PriorityPlanKey[]>(() => buildDefaultSelection(props.priorityCounts));
  const [draftOrder, setDraftOrder] = useState<PriorityPlanKey[]>(() => normalizePriorityPlanOrder(props.priorityPlanOrder));
  const [draftRanges, setDraftRanges] = useState<DraftRangeMap>(() =>
    buildInitialRanges(props.priorityCounts, normalizePriorityPlanOrder(props.priorityPlanOrder), buildDefaultSelection(props.priorityCounts), props.priorityPlanRanges ?? {}),
  );

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const nextSelection = buildDefaultSelection(props.priorityCounts);
    const nextOrder = normalizePriorityPlanOrder(props.priorityPlanOrder);
    setSelectedGroups(nextSelection);
    setDraftOrder(nextOrder);
    setDraftRanges(buildInitialRanges(props.priorityCounts, nextOrder, nextSelection, props.priorityPlanRanges ?? {}));
  }, [props.open, props.priorityCounts, props.priorityPlanOrder, props.priorityPlanRanges]);

  const parsedRanges = useMemo(() => buildSubmittedRanges(draftRanges), [draftRanges]);

  const preview = useMemo(
    () => buildPriorityPlanPreview(props.priorityCounts, draftOrder, selectedGroups, parsedRanges),
    [draftOrder, parsedRanges, props.priorityCounts, selectedGroups],
  );

  const hasInvalidSelectedRange = selectedGroups.some((key) => !parseDraftRange(draftRanges[key]));

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
                const range = draftRanges[entry.key] ?? { minPriority: "", maxPriority: "" };
                const parsedRange = parseDraftRange(range);

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
                      {checked ? (
                        <div className="priority-order-card__range-controls">
                          <input
                            type="number"
                            min="0"
                            inputMode="numeric"
                            value={range.minPriority}
                            disabled={props.saving}
                            aria-label={`${labelPriorityPlan(entry.key)} 最小优先级`}
                            onChange={(event) =>
                              setDraftRanges((current) => ({
                                ...current,
                                [entry.key]: {
                                  minPriority: event.target.value,
                                  maxPriority: current[entry.key]?.maxPriority ?? range.maxPriority,
                                },
                              }))
                            }
                          />
                          <span className="priority-order-card__range-separator">-</span>
                          <input
                            type="number"
                            min="0"
                            inputMode="numeric"
                            value={range.maxPriority}
                            disabled={props.saving}
                            aria-label={`${labelPriorityPlan(entry.key)} 最大优先级`}
                            onChange={(event) =>
                              setDraftRanges((current) => ({
                                ...current,
                                [entry.key]: {
                                  minPriority: current[entry.key]?.minPriority ?? range.minPriority,
                                  maxPriority: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                      ) : (
                        <strong>{buildRangeLabel(entry, checked)}</strong>
                      )}
                    </div>
                    <div className="priority-order-card__bucket">
                      {buildBucketSummary(entry.count, parsedRange, checked)}
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
                priorityPlanRanges: parsedRanges,
              })
            }
            disabled={props.saving || selectedGroups.length === 0 || hasInvalidSelectedRange}
          >
            {props.saving ? "生成中" : "生成本地草稿"}
          </button>
        </footer>
      </section>
    </div>
  );
}
