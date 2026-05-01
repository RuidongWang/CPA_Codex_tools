import type { CSSProperties } from "react";

interface ProgressPanelProps {
  active: boolean;
  closing?: boolean;
  title: string;
  completed: number;
  total: number;
  currentLabel: string;
  elapsedLabel?: string;
  style?: CSSProperties;
}

function formatPercent(completed: number, total: number): number {
  if (!total) {
    return 0;
  }
  return Math.round((completed / total) * 100);
}

// 查询进度改成扫描条样式，信息始终贴近表格主视区。
export function ProgressPanel(props: ProgressPanelProps) {
  if (!props.active) {
    return null;
  }

  const percent = formatPercent(props.completed, props.total);
  const className = props.closing ? "scan-progress scan-progress--closing" : "scan-progress";

  return (
    <section className={className} style={props.style} aria-live="polite">
      <div className="scan-progress__header">
        <span>{props.title}</span>
        <span>{percent}%</span>
      </div>
      <div className="scan-progress__meta">
        <span>
          {props.completed} / {props.total}
        </span>
        <span>{props.currentLabel || "等待开始"}</span>
      </div>
      {props.elapsedLabel ? <div className="scan-progress__elapsed">{props.elapsedLabel}</div> : null}
      <div className="scan-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={props.total} aria-valuenow={props.completed}>
        <span className="scan-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}
