"""通过 CPA 管理接口查询 Codex 账号状态和额度。"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, TextIO
from urllib import parse
from urllib import error, request

DEFAULT_CPA_BASE_URL = "https://cpa.example/"
WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal"
WINDOW_5H_SECONDS = 5 * 60 * 60
WINDOW_7D_SECONDS = 7 * 24 * 60 * 60
LOW_5H_THRESHOLD = 20.0
LOW_7D_THRESHOLD = 15.0


def force_utf8_stdio() -> None:
    """在 Windows 管道环境里强制标准流使用 UTF-8，避免桌面端读到本地代码页字节。"""

    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        kwargs: dict[str, Any] = {"encoding": "utf-8"}
        if stream_name != "stdin":
            # worker 需要逐行立刻把 JSON 推给桌面端，避免缓冲把进度事件卡住。
            kwargs["write_through"] = True
        try:
            reconfigure(**kwargs)
        except ValueError:
            # 某些受限宿主会提前替换标准流；这种场景下保持原状即可。
            continue


@dataclass
class AuthRecord:
    """承载单个 Codex 账号的最小信息。"""

    name: str
    email: str
    plan_type: str
    account_id: str
    auth_index: str
    priority: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class QuotaWindow:
    """单个额度窗口的展示结构。"""

    id: str
    label: str
    used_percent: float | None
    remaining_percent: float | None
    reset_label: str
    exhausted: bool


@dataclass
class QuotaReport:
    """单个 Codex 账号的完整查询结果。"""

    name: str
    email: str
    plan_type: str
    account_id: str
    auth_index: str
    status: str
    priority: int | None = None
    windows: list[QuotaWindow] = field(default_factory=list)
    additional_windows: list[QuotaWindow] = field(default_factory=list)
    error: str = ""
    timings_ms: dict[str, float] = field(default_factory=dict)


def clean_str(value: Any) -> str:
    """把输入统一转成去空白字符串。"""

    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def normalize_plan(value: Any) -> str:
    """计划类型统一转小写，便于排序和筛选。"""

    return clean_str(value).lower()


def first_non_empty(*values: Any) -> str:
    """返回第一个非空字符串值。"""

    for value in values:
        text = clean_str(value)
        if text:
            return text
    return ""


def first_present(*values: Any) -> Any:
    """只跳过 None，保留 0 和 False。"""

    for value in values:
        if value is not None:
            return value
    return None


def first_token_like(*values: Any) -> Any:
    """保留 dict 版 token，同时继续跳过空字符串。"""

    for value in values:
        # CPA 的 id_token 既可能是 JWT 字符串，也可能已经是 claims 字典。
        if isinstance(value, dict):
            return value
        text = clean_str(value)
        if text:
            return text
    return None


def format_duration_ms(duration_ms: float) -> str:
    """把毫秒数格式化成便于人工比较的文本。"""

    if duration_ms >= 1000:
        return f"{duration_ms / 1000:.2f}s"
    return f"{duration_ms:.0f}ms"


def round_duration_ms(started_at: float) -> float:
    """统一把 perf_counter 差值折算成毫秒。"""

    return round((time.perf_counter() - started_at) * 1000, 1)


def normalize_priority(value: Any) -> int | None:
    """把优先级统一成整数，无法识别时返回 None。"""

    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = clean_str(value)
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def nested_get(data: dict[str, Any], *keys: str) -> Any:
    """安全读取嵌套字典。"""

    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def decode_jwt_payload(token: str) -> dict[str, Any]:
    """只解析 JWT payload，用于读取账号 claim。"""

    raw = clean_str(token)
    if not raw:
        return {}
    parts = raw.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    remainder = len(payload) % 4
    if remainder == 2:
        payload += "=="
    elif remainder == 3:
        payload += "="
    elif remainder == 1:
        return {}
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8"))
        parsed = json.loads(decoded.decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def extract_codex_claims(value: Any) -> dict[str, str]:
    """兼容 JWT 字符串和已解开的 claim 字典。"""

    payload = decode_jwt_payload(value) if isinstance(value, str) else value if isinstance(value, dict) else {}
    auth_info = nested_get(payload, "https://api.openai.com/auth")
    if not isinstance(auth_info, dict):
        auth_info = {}
    return {
        "email": first_non_empty(payload.get("email")),
        "account_id": first_non_empty(
            payload.get("chatgpt_account_id"),
            payload.get("account_id"),
            auth_info.get("chatgpt_account_id"),
        ),
        "plan_type": normalize_plan(
            first_non_empty(
                payload.get("plan_type"),
                payload.get("chatgpt_plan_type"),
                auth_info.get("chatgpt_plan_type"),
            )
        ),
    }


def infer_plan_from_name(name: str) -> str:
    """从文件名补 plan_type，兼容旧 auth-files 返回。"""

    raw = clean_str(name).lower()
    for suffix in ("-free.json", "-plus.json", "-team.json"):
        if raw.endswith(suffix):
            return suffix.removeprefix("-").removesuffix(".json")
    return ""


def http_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, str]:
    """统一发送 HTTP 请求，并保留非 2xx 响应体。"""

    req = request.Request(url=url, method=method, data=data, headers=headers or {})
    try:
        with request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, Any]]:
    """发送 JSON 请求并返回对象结构。"""

    status, body = http_request(url, method=method, headers=headers, data=data, timeout=timeout)
    if not clean_str(body):
        return status, {}
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"接口没有返回合法 JSON: {body[:200]}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("接口返回不是对象结构")
    return status, payload


def build_management_headers(management_key: str) -> dict[str, str]:
    """统一构造管理接口请求头。"""

    headers: dict[str, str] = {}
    normalized_key = clean_str(management_key)
    if normalized_key:
        # 公开仓库同时兼容 Bearer 和旧版 X-Management-Key，避免 CLI/worker 与前端行为漂移。
        headers["Authorization"] = f"Bearer {normalized_key}"
        headers["X-Management-Key"] = normalized_key
    return headers


def build_auth_records_from_auth_files(raw_files: list[Any]) -> list[AuthRecord]:
    """把 CPA 的 auth-files 返回收敛成脚本需要的结构。"""

    records: list[AuthRecord] = []
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        provider = normalize_plan(first_non_empty(item.get("provider"), item.get("type")))
        if provider != "codex":
            continue
        # 这里要保留 dict 版 id_token，否则会把 chatgpt_account_id 丢掉。
        claims = extract_codex_claims(first_token_like(item.get("id_token"), nested_get(item, "metadata", "id_token")))
        name = first_non_empty(item.get("name"), item.get("id"), claims["email"], "unknown")
        records.append(
            AuthRecord(
                name=name,
                email=first_non_empty(item.get("email"), claims["email"]),
                plan_type=first_non_empty(item.get("plan_type"), claims["plan_type"], infer_plan_from_name(name), "unknown"),
                account_id=first_non_empty(item.get("chatgpt_account_id"), claims["account_id"]),
                auth_index=first_non_empty(item.get("auth_index"), item.get("authIndex")),
                priority=normalize_priority(item.get("priority")),
                raw=item,
            )
        )
    return sort_auth_records(records)


def build_auth_records_from_cached_items(raw_items: list[Any]) -> list[AuthRecord]:
    """把桌面端已缓存的账号列表重新收敛成 AuthRecord，避免重复拉 auth-files。"""

    records: list[AuthRecord] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        records.append(
            AuthRecord(
                name=first_non_empty(item.get("name"), item.get("email"), "unknown"),
                email=first_non_empty(item.get("email")),
                plan_type=first_non_empty(item.get("plan_type"), "unknown"),
                account_id=first_non_empty(item.get("account_id")),
                auth_index=first_non_empty(item.get("auth_index"), item.get("authIndex")),
                priority=normalize_priority(item.get("priority")),
                raw=item,
            )
        )
    return sort_auth_records(records)


def needs_auth_prefetch(record: AuthRecord) -> bool:
    """只有缺少后续查询必需字段的账号，才在加载阶段补下载。"""

    return not clean_str(record.account_id)


def preload_missing_auth_details(base_url: str, management_key: str, records: list[AuthRecord], timeout: float) -> list[AuthRecord]:
    """列表加载后先补齐缺失的 account_id，减少后续额度查询前的额外往返。"""

    pending = [record for record in records if needs_auth_prefetch(record)]
    if not pending:
        return records

    for record in pending:
        try:
            payload = download_auth_file(base_url, management_key, record.name, timeout)
            apply_downloaded_auth_payload(record, payload)
        except RuntimeError as exc:
            # 预补全失败时不打断整个列表加载，后续查询阶段仍会保留兜底补全。
            if isinstance(record.raw, dict):
                record.raw["prefetch_error"] = str(exc)
    return records


def load_cpa_auth_records(base_url: str, management_key: str, timeout: float) -> list[AuthRecord]:
    """通过 CPA 管理接口读取全部 Codex 账号。"""

    status, payload = request_json(
        f"{base_url.rstrip('/')}/v0/management/auth-files",
        headers=build_management_headers(management_key),
        timeout=timeout,
    )
    if status != 200:
        raise RuntimeError(payload.get("error", f"获取 auth-files 失败，HTTP {status}"))
    raw_files = payload.get("files")
    if not isinstance(raw_files, list):
        raise RuntimeError("CPA 返回的 auth-files 结构不正确")
    records = build_auth_records_from_auth_files(raw_files)
    return preload_missing_auth_details(base_url, management_key, records, timeout)


def download_auth_file(base_url: str, management_key: str, name: str, timeout: float) -> dict[str, Any]:
    """通过只读下载接口获取原始 auth JSON。"""

    query = parse.urlencode({"name": name})
    status, body = http_request(
        f"{base_url.rstrip('/')}/v0/management/auth-files/download?{query}",
        headers=build_management_headers(management_key),
        timeout=timeout,
    )
    if status != 200:
        raise RuntimeError(f"下载 auth 文件失败，HTTP {status}")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("下载的 auth 文件不是合法 JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("下载的 auth 文件结构不正确")
    return payload


def sort_auth_records(records: list[AuthRecord]) -> list[AuthRecord]:
    """展示顺序优先看计划，再看文件名。"""

    plan_rank = {"free": 0, "plus": 1, "team": 2, "pro 5x": 3, "pro 20x": 4}
    return sorted(records, key=lambda item: (plan_rank.get(item.plan_type, 99), item.name.lower()))


def parse_record_selection(choice: str, total: int) -> list[int]:
    """把 all 或逗号分隔编号解析成稳定的记录下标。"""

    normalized = clean_str(choice).lower()
    if normalized in {"all", "a", "*"}:
        return list(range(total))

    indexes: list[int] = []
    seen: set[int] = set()
    for part in normalized.split(","):
        token = clean_str(part)
        if not token or not token.isdigit():
            raise RuntimeError("输入无效，请输入编号、逗号分隔的多个编号或 all。")
        index = int(token)
        if index < 1 or index > total:
            raise RuntimeError(f"编号超出范围: {index}")
        zero_based = index - 1
        if zero_based in seen:
            continue
        seen.add(zero_based)
        indexes.append(zero_based)
    if not indexes:
        raise RuntimeError("没有选中任何账号")
    return indexes


def describe_report_timings(report: QuotaReport) -> str:
    """把单账号查询的关键步骤耗时压成单行。"""

    ordered_keys = [
        ("query_total_ms", "总耗时"),
        ("api_call_ms", "额度接口"),
        ("download_auth_file_ms", "auth 下载"),
    ]
    parts: list[str] = []
    for key, label in ordered_keys:
        value = report.timings_ms.get(key)
        if value is None:
            continue
        parts.append(f"{label} {format_duration_ms(value)}")
    return " | ".join(parts)


def choose_records_interactively(
    records: list[AuthRecord],
    *,
    prefetched_choice: str | None = None,
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], None] = print,
) -> list[AuthRecord]:
    """交互式选择单个账号或全部账号。"""

    if not records:
        raise RuntimeError("没有可查询的 Codex 账号")
    if len(records) == 1:
        output_fn(f"只找到 1 个 Codex 账号，自动选择: {records[0].name}")
        return records
    output_fn("找到以下 Codex 账号")
    for index, record in enumerate(records, start=1):
        output_fn(
            f"[{index}] {record.name} | 邮箱 {record.email or '-'} | 计划 {record.plan_type or '-'} | auth_index {record.auth_index or '-'}"
        )
    if prefetched_choice is not None:
        return [records[index] for index in parse_record_selection(prefetched_choice, len(records))]
    while True:
        choice = clean_str(input_fn("输入编号查询账号，可用逗号分隔多个编号，输入 all 查询全部: "))
        try:
            indexes = parse_record_selection(choice, len(records))
            return [records[index] for index in indexes]
        except RuntimeError:
            output_fn("输入无效，请重新输入编号、逗号分隔的多个编号或 all。")


def apply_downloaded_auth_payload(record: AuthRecord, payload: dict[str, Any]) -> None:
    """把下载到的原始 auth JSON 回填到记录里。"""

    claims = extract_codex_claims(first_non_empty(payload.get("id_token")))
    record.email = first_non_empty(record.email, payload.get("email"), claims["email"])
    current_plan = "" if normalize_plan(record.plan_type) == "unknown" else record.plan_type
    record.plan_type = first_non_empty(current_plan, claims["plan_type"], infer_plan_from_name(record.name), "unknown")
    record.account_id = first_non_empty(record.account_id, payload.get("account_id"), claims["account_id"])
    record.priority = normalize_priority(first_present(record.priority, payload.get("priority")))
    if isinstance(record.raw, dict):
        record.raw.update(payload)


def ensure_record_account_id(base_url: str, management_key: str, record: AuthRecord, timeout: float) -> float | None:
    """优先用 auth-files，缺失时再走下载接口补全账号 ID。"""

    if clean_str(record.account_id):
        return None
    started_at = time.perf_counter()
    payload = download_auth_file(base_url, management_key, record.name, timeout)
    apply_downloaded_auth_payload(record, payload)
    return round_duration_ms(started_at)


def build_wham_api_call_payload(record: AuthRecord) -> dict[str, Any]:
    """固定走 CPA 的 api-call 代发 wham/usage。"""

    return {
        "auth_index": record.auth_index,
        "method": "GET",
        "url": WHAM_USAGE_URL,
        "header": {
            "Authorization": "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "User-Agent": CODEX_USER_AGENT,
            "Chatgpt-Account-Id": record.account_id,
        },
    }


def query_codex_quota_via_cpa(base_url: str, management_key: str, record: AuthRecord, timeout: float) -> QuotaReport:
    """通过 CPA 的 api-call 查询单个 Codex 账号额度。"""

    query_started_at = time.perf_counter()
    report = QuotaReport(
        name=record.name,
        email=record.email,
        plan_type=record.plan_type or "unknown",
        account_id=record.account_id,
        auth_index=record.auth_index,
        status="unknown",
        priority=record.priority,
    )
    def finalize_report() -> QuotaReport:
        report.timings_ms["query_total_ms"] = round_duration_ms(query_started_at)
        return report

    try:
        download_elapsed_ms = ensure_record_account_id(base_url, management_key, record, timeout)
        if download_elapsed_ms is not None:
            report.timings_ms["download_auth_file_ms"] = download_elapsed_ms
    except RuntimeError as exc:
        report.error = str(exc)
        report.status = derive_codex_status(report)
        return finalize_report()
    report.email = record.email
    report.plan_type = record.plan_type or report.plan_type
    report.account_id = record.account_id
    if not report.auth_index:
        report.error = "缺少 auth_index"
        report.status = derive_codex_status(report)
        return finalize_report()
    if not report.account_id:
        report.error = "缺少 chatgpt_account_id"
        report.status = derive_codex_status(report)
        return finalize_report()

    headers = build_management_headers(management_key)
    headers["Content-Type"] = "application/json"
    api_call_started_at = time.perf_counter()
    status, response = request_json(
        f"{base_url.rstrip('/')}/v0/management/api-call",
        method="POST",
        headers=headers,
        data=json.dumps(build_wham_api_call_payload(record)).encode("utf-8"),
        timeout=timeout,
    )
    report.timings_ms["api_call_ms"] = round_duration_ms(api_call_started_at)
    if status != 200:
        report.error = response.get("error", f"CPA 调用失败，HTTP {status}")
        report.status = derive_codex_status(report)
        return finalize_report()

    upstream_status = int(response.get("status_code", 0))
    body_text = response.get("body", "")
    try:
        body = json.loads(body_text) if isinstance(body_text, str) and clean_str(body_text) else {}
    except json.JSONDecodeError:
        body = {}
    if upstream_status < 200 or upstream_status >= 300:
        report.error = clean_str(body_text) or f"OpenAI 返回 HTTP {upstream_status}"
        report.status = derive_codex_status(report)
        return finalize_report()
    if not isinstance(body, dict):
        report.error = "wham/usage 返回结构不正确"
        report.status = derive_codex_status(report)
        return finalize_report()

    report.plan_type = first_non_empty(body.get("plan_type"), body.get("planType"), report.plan_type)
    report.priority = normalize_priority(first_present(report.priority, body.get("priority")))
    report.windows = parse_codex_windows(body)
    report.additional_windows = parse_additional_windows(body)
    report.status = derive_codex_status(report)
    return finalize_report()


def parse_codex_windows(payload: dict[str, Any]) -> list[QuotaWindow]:
    """解析主额度窗口，优先识别 5h 和 7d。"""

    rate_limit = first_present(payload.get("rate_limit"), payload.get("rateLimit"))
    if not isinstance(rate_limit, dict):
        return []
    five_hour, weekly = find_quota_windows(rate_limit)
    windows: list[QuotaWindow] = []
    for window in (
        build_window("code-5h", "5h", five_hour, rate_limit.get("limit_reached"), rate_limit.get("allowed")),
        build_window("code-7d", "7d", weekly, rate_limit.get("limit_reached"), rate_limit.get("allowed")),
    ):
        if window is not None:
            windows.append(window)
    return windows


def parse_additional_windows(payload: dict[str, Any]) -> list[QuotaWindow]:
    """保留 Inspector 里的附加限额解析逻辑。"""

    raw_windows = first_present(payload.get("additional_rate_limits"), payload.get("additionalRateLimits"))
    if not isinstance(raw_windows, list):
        return []
    results: list[QuotaWindow] = []
    for index, item in enumerate(raw_windows, start=1):
        if not isinstance(item, dict):
            continue
        rate_limit = first_present(item.get("rate_limit"), item.get("rateLimit"))
        if not isinstance(rate_limit, dict):
            continue
        name = first_non_empty(
            item.get("limit_name"),
            item.get("limitName"),
            item.get("metered_feature"),
            item.get("meteredFeature"),
            f"additional-{index}",
        )
        primary = first_present(rate_limit.get("primary_window"), rate_limit.get("primaryWindow"))
        secondary = first_present(rate_limit.get("secondary_window"), rate_limit.get("secondaryWindow"))
        for window in (
            build_window(f"{name}-primary", f"{name} 5h", primary, rate_limit.get("limit_reached"), rate_limit.get("allowed")),
            build_window(f"{name}-secondary", f"{name} 7d", secondary, rate_limit.get("limit_reached"), rate_limit.get("allowed")),
        ):
            if window is not None:
                results.append(window)
    return results


def find_quota_windows(rate_limit: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """按秒数区分 5h / 7d，避免主次窗口顺序变化。"""

    primary = first_present(rate_limit.get("primary_window"), rate_limit.get("primaryWindow"))
    secondary = first_present(rate_limit.get("secondary_window"), rate_limit.get("secondaryWindow"))
    five_hour = None
    weekly = None
    for candidate in (primary, secondary):
        if not isinstance(candidate, dict):
            continue
        seconds = int(number_from_any(first_present(candidate.get("limit_window_seconds"), candidate.get("limitWindowSeconds"))))
        if seconds == WINDOW_5H_SECONDS and five_hour is None:
            five_hour = candidate
        if seconds == WINDOW_7D_SECONDS and weekly is None:
            weekly = candidate
    if five_hour is None and weekly is None:
        return (
            primary if isinstance(primary, dict) else None,
            secondary if isinstance(secondary, dict) else None,
        )
    return five_hour, weekly


def build_window(window_id: str, label: str, window: Any, limit_reached: Any, allowed: Any) -> QuotaWindow | None:
    """把接口窗口结构转成统一展示结构。"""

    if not isinstance(window, dict):
        return None
    used_percent = deduce_used_percent(window, limit_reached, allowed)
    remaining_percent = None if used_percent is None else clamp_float(100.0 - used_percent, 0.0, 100.0)
    return QuotaWindow(
        id=window_id,
        label=label,
        used_percent=used_percent,
        remaining_percent=remaining_percent,
        reset_label=format_reset_label(window),
        exhausted=used_percent is not None and used_percent >= 100.0,
    )


def deduce_used_percent(window: dict[str, Any], limit_reached: Any, allowed: Any) -> float | None:
    """优先读 used_percent，没有时再退化到 exhausted 推断。"""

    direct_value = number_or_none(first_present(window.get("used_percent"), window.get("usedPercent")))
    if direct_value is not None:
        return clamp_float(direct_value, 0.0, 100.0)
    exhausted_hint = bool_from_any(limit_reached) or allowed is False
    if exhausted_hint and format_reset_label(window) != "-":
        return 100.0
    return None


def format_reset_label(window: dict[str, Any]) -> str:
    """重置时间统一输出为月日时分。"""

    reset_at = number_or_none(first_present(window.get("reset_at"), window.get("resetAt")))
    if reset_at is not None and reset_at > 0:
        return datetime.fromtimestamp(reset_at).strftime("%m-%d %H:%M")
    reset_after_seconds = number_or_none(first_present(window.get("reset_after_seconds"), window.get("resetAfterSeconds")))
    if reset_after_seconds is not None and reset_after_seconds > 0:
        return (datetime.now() + timedelta(seconds=reset_after_seconds)).strftime("%m-%d %H:%M")
    return "-"


def number_or_none(value: Any) -> float | None:
    """兼容字符串数字和原生数字。"""

    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip().removesuffix("%")
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None
    return None


def number_from_any(value: Any) -> float:
    """需要默认 0 时统一走这个入口。"""

    parsed = number_or_none(value)
    return 0.0 if parsed is None else parsed


def bool_from_any(value: Any) -> bool:
    """兼容布尔值和字符串布尔值。"""

    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


def clamp_float(value: float, lower: float, upper: float) -> float:
    """把百分比稳定裁剪在合法范围。"""

    return max(lower, min(upper, value))


def derive_codex_status(report: QuotaReport) -> str:
    """状态规则与 Inspector 保持一致，主看 7d 剩余额度。"""

    if report.error:
        return "error"
    if not report.account_id:
        return "missing"
    window_7d = next((item for item in report.windows if item.id == "code-7d"), None)
    if window_7d is None or window_7d.remaining_percent is None:
        return "unknown"
    remaining = window_7d.remaining_percent
    if remaining <= 0:
        return "exhausted"
    if remaining <= 30:
        return "low"
    if remaining <= 70:
        return "medium"
    if remaining < 100:
        return "high"
    return "full"


def now_iso() -> str:
    """统一生成桌面端使用的本地 ISO 时间戳。"""

    return datetime.now().astimezone().isoformat(timespec="seconds")


def serialize_window(window: QuotaWindow) -> dict[str, Any]:
    """把额度窗口展开成前端可直接消费的结构。"""

    return asdict(window)


def build_meta(*, total: int, success: int, failed: int) -> dict[str, Any]:
    """统一生成桌面端 payload 的元信息。"""

    return {
        "generated_at": now_iso(),
        "total": total,
        "success": success,
        "failed": failed,
    }


def derive_desktop_status(report: QuotaReport) -> str:
    """桌面端只保留健康、低额度、耗尽、异常和未知五种状态。"""

    if report.error:
        return "error"
    if not report.account_id:
        return "error"
    window_5h = next((item for item in report.windows if item.id == "code-5h"), None)
    window_7d = next((item for item in report.windows if item.id == "code-7d"), None)
    if (window_5h is None or window_5h.remaining_percent is None) and (window_7d is None or window_7d.remaining_percent is None):
        return "unknown"
    if any(item.exhausted for item in report.windows):
        return "exhausted"
    if window_5h is not None and window_5h.remaining_percent is not None and window_5h.remaining_percent <= LOW_5H_THRESHOLD:
        return "low"
    if window_7d is not None and window_7d.remaining_percent is not None and window_7d.remaining_percent <= LOW_7D_THRESHOLD:
        return "low"
    return "healthy"


def auth_record_to_item(record: AuthRecord) -> dict[str, Any]:
    """列表接口使用基础账号信息构造未查询态条目。"""

    return {
        "name": record.name,
        "email": record.email,
        "plan_type": record.plan_type or "unknown",
        "account_id": record.account_id,
        "auth_index": record.auth_index,
        "priority": record.priority,
        "status": "unknown",
        "windows": [],
        "additional_windows": [],
        "error": "",
        "last_query_at": None,
        "quota_updated_at": None,
    }


def primary_quota_reset_label(windows: list[QuotaWindow]) -> str | None:
    """额度更新时间列复用 5h 主额度里的下次刷新时间。"""

    for window in windows:
        if window.id == "code-5h" and window.reset_label and window.reset_label != "-":
            return window.reset_label
    return None


def report_to_item(report: QuotaReport) -> dict[str, Any]:
    """查询接口把单个账号结果整理成统一条目。"""

    status = derive_desktop_status(report)
    report.status = status
    return {
        "name": report.name,
        "email": report.email,
        "plan_type": report.plan_type or "unknown",
        "account_id": report.account_id,
        "auth_index": report.auth_index,
        "priority": report.priority,
        "status": status,
        "windows": [serialize_window(window) for window in report.windows],
        "additional_windows": [serialize_window(window) for window in report.additional_windows],
        "error": report.error,
        "timings_ms": dict(report.timings_ms),
        "last_query_at": now_iso(),
        "quota_updated_at": primary_quota_reset_label(report.windows),
    }


def build_group_counts(items: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """按计划和状态统计当前条目集合。"""

    plan_counter = Counter(clean_str(item.get("plan_type")) or "unknown" for item in items)
    status_counter = Counter(clean_str(item.get("status")) or "unknown" for item in items)
    return {
        "by_plan": dict(sorted(plan_counter.items())),
        "by_status": dict(sorted(status_counter.items())),
    }


def build_list_payload(records: list[AuthRecord]) -> dict[str, Any]:
    """桌面端列表接口返回基础账号清单和分组统计。"""

    items = [auth_record_to_item(record) for record in records]
    return {
        "meta": build_meta(total=len(items), success=0, failed=0),
        "groups": build_group_counts(items),
        "items": items,
        "error": "",
    }


def build_query_payload(reports: list[QuotaReport]) -> dict[str, Any]:
    """桌面端查询接口返回完整账号结果和分组统计。"""

    items = [report_to_item(report) for report in reports]
    failed = sum(1 for item in items if item["status"] == "error")
    return {
        "meta": build_meta(total=len(items), success=len(items) - failed, failed=failed),
        "groups": build_group_counts(items),
        "items": items,
        "error": "",
    }


def render_reports(reports: list[QuotaReport], *, show_timings: bool = False) -> None:
    """终端输出按账号展开，再补一个汇总。"""

    for report in reports:
        print("=" * 88)
        print(f"{report.name} | 邮箱 {report.email or '-'} | 计划 {report.plan_type or '-'} | 状态 {report.status}")
        print(f"auth_index: {report.auth_index or '-'}")
        print(f"账号 ID: {report.account_id or '-'}")
        if report.error:
            print(f"错误: {report.error}")
            if show_timings and report.timings_ms:
                print("耗时: " + describe_report_timings(report))
            continue
        print_windows(report.windows)
        if report.additional_windows:
            print("附加窗口:")
            print_windows(report.additional_windows, indent="  ")
        if show_timings and report.timings_ms:
            print("耗时: " + describe_report_timings(report))
    print("=" * 88)
    render_summary(reports)


def print_windows(windows: list[QuotaWindow], indent: str = "") -> None:
    """主窗口和附加窗口共用同一套输出。"""

    if not windows:
        print(f"{indent}未拿到额度窗口数据")
        return
    for window in windows:
        remaining = "?"
        if window.remaining_percent is not None:
            remaining = f"{window.remaining_percent:.0f}%"
        used = "?"
        if window.used_percent is not None:
            used = f"{window.used_percent:.0f}%"
        print(f"{indent}{window.label:<18} 剩余 {remaining:<5} 已用 {used:<5} 重置 {window.reset_label}")


def render_summary(reports: list[QuotaReport]) -> None:
    """批量查询时补一个最小汇总。"""

    status_counter = Counter(report.status for report in reports)
    plan_counter = Counter(report.plan_type or "unknown" for report in reports)
    print(f"共查询 {len(reports)} 个账号")
    print("状态汇总: " + ", ".join(f"{key}:{value}" for key, value in sorted(status_counter.items())))
    print("计划汇总: " + ", ".join(f"{key}:{value}" for key, value in sorted(plan_counter.items())))


def print_cli_progress(report: QuotaReport, completed: int, total: int) -> None:
    """手动测时场景在每个账号结束后立刻打印进度。"""

    label = report.email or report.name
    print(f"[{completed}/{total}] {label} | 状态 {report.status} | {describe_report_timings(report)}")


def print_cli_timing_summary(*, load_records_ms: float, batch_started_at: float, reports: list[QuotaReport]) -> None:
    """把列表加载和批量查询的总体耗时集中打印出来。"""

    print("=" * 88)
    print(f"列表加载耗时: {format_duration_ms(load_records_ms)}")
    print(f"批量查询耗时: {format_duration_ms(round_duration_ms(batch_started_at))}")
    if reports:
        average_ms = round(sum(report.timings_ms.get("query_total_ms", 0.0) for report in reports) / len(reports), 1)
        print(f"单账号平均耗时: {format_duration_ms(average_ms)}")


def add_common_args(parser: argparse.ArgumentParser) -> None:
    """命令行公共参数统一放在这里，避免根命令和子命令重复漂移。"""

    parser.add_argument("--cpa-base-url", help="CPA 服务地址，例如 https://cpa.example/")
    parser.add_argument("--management-key", help="CPA 管理密钥")
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP 超时时间，默认 30 秒")
    parser.add_argument("--select", help="根命令下按展示编号选择多个账号，例如 1,3,5 或 all")
    parser.add_argument("--show-timings", action="store_true", help="打印关键步骤的耗时")
    parser.add_argument("--max-workers", type=int, help="额度查询并发数，默认 6")
    parser.add_argument("--emit-progress", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="把查询结果输出成 JSON")


def parse_args(argv: list[str]) -> argparse.Namespace:
    """同时支持原始交互模式和桌面端子命令模式。"""

    common = argparse.ArgumentParser(add_help=False)
    add_common_args(common)
    parser = argparse.ArgumentParser(description="通过 CPA 接口查询 Codex 账号额度", parents=[common])
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("list", parents=[common], help="输出账号列表和基础分组")

    query_one_parser = subparsers.add_parser("query-one", parents=[common], help="查询单个账号额度")
    query_one_parser.add_argument("--auth-index", required=True, help="要查询的 auth_index")

    query_many_parser = subparsers.add_parser("query-many", parents=[common], help="查询多个账号额度")
    query_many_parser.add_argument("--auth-index", required=True, help="逗号分隔的多个 auth_index")

    subparsers.add_parser("query-records", parents=[common], help="查询桌面端已缓存的账号额度")
    subparsers.add_parser("query-all", parents=[common], help="查询全部账号额度")
    return parser.parse_args(argv)


def payload_to_json(payload: dict[str, Any]) -> str:
    """桌面端和命令行的 JSON 输出统一走这里。"""

    return json.dumps(payload, ensure_ascii=False, indent=2)


def resolve_base_url(args: argparse.Namespace, *, allow_prompt: bool) -> str:
    """交互模式允许提示输入，但不再默默兜底到开发期地址。"""

    if clean_str(args.cpa_base_url):
        return clean_str(args.cpa_base_url)
    if allow_prompt:
        entered = clean_str(input(f"输入 CPA 地址，例如 {DEFAULT_CPA_BASE_URL}: "))
        if entered:
            return entered
    raise RuntimeError("缺少 CPA 地址，请先通过 --cpa-base-url 或界面配置填写")


def resolve_management_key(args: argparse.Namespace, *, allow_prompt: bool) -> str:
    """桌面端模式避免阻塞，交互模式仍保留手动输入。"""

    if clean_str(args.management_key):
        return clean_str(args.management_key)
    if allow_prompt:
        return clean_str(input("输入 management key，可直接回车留空: "))
    return ""


def split_auth_indexes(value: str) -> list[str]:
    """把逗号分隔的 auth_index 参数整理成去重列表。"""

    results: list[str] = []
    seen: set[str] = set()
    for part in clean_str(value).split(","):
        current = clean_str(part)
        if not current or current in seen:
            continue
        seen.add(current)
        results.append(current)
    return results


def select_records_by_auth_indexes(records: list[AuthRecord], auth_indexes: list[str]) -> list[AuthRecord]:
    """根据 auth_index 稳定挑出要查询的账号，并对缺失项给出明确报错。"""

    by_index = {record.auth_index: record for record in records if clean_str(record.auth_index)}
    missing = [auth_index for auth_index in auth_indexes if auth_index not in by_index]
    if missing:
        raise RuntimeError("找不到指定 auth_index: " + ", ".join(missing))
    return [by_index[auth_index] for auth_index in auth_indexes]


def query_reports(
    base_url: str,
    management_key: str,
    records: list[AuthRecord],
    timeout: float,
    *,
    query_fn: Callable[[str, str, AuthRecord, float], QuotaReport] = query_codex_quota_via_cpa,
    max_workers: int | None = None,
    progress_fn: Callable[[QuotaReport, int, int], None] | None = None,
) -> list[QuotaReport]:
    """统一执行额度查询，供交互模式和桌面端模式共用。"""

    return query_reports_parallel(
        base_url,
        management_key,
        records,
        timeout,
        query_fn=query_fn,
        max_workers=max_workers,
        progress_fn=progress_fn,
    )


def query_reports_parallel(
    base_url: str,
    management_key: str,
    records: list[AuthRecord],
    timeout: float,
    *,
    query_fn: Callable[[str, str, AuthRecord, float], QuotaReport] = query_codex_quota_via_cpa,
    max_workers: int | None = None,
    progress_fn: Callable[[QuotaReport, int, int], None] | None = None,
) -> list[QuotaReport]:
    """批量查询默认走受控并发，减少总等待时间。"""

    if not records:
        return []

    # 账号数量可能很多，这里给线程数加上上限，避免把远端管理接口打爆。
    requested_workers = 6 if max_workers is None else max_workers
    worker_count = max(1, min(requested_workers, len(records)))

    def run_single(record: AuthRecord) -> QuotaReport:
        """把公共参数收进闭包，便于 executor.map 保持顺序。"""

        started_at = time.perf_counter()
        try:
            report = query_fn(base_url, management_key, record, timeout)
        except Exception as exc:  # noqa: BLE001
            report = QuotaReport(
                name=record.name,
                email=record.email,
                plan_type=record.plan_type or "unknown",
                account_id=record.account_id,
                auth_index=record.auth_index,
                status="error",
                priority=record.priority,
                error=f"未捕获异常: {exc}",
            )
        report.timings_ms.setdefault("query_total_ms", round_duration_ms(started_at))
        return report

    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="codex-quota") as executor:
        future_to_index = {
            executor.submit(run_single, record): index
            for index, record in enumerate(records)
        }
        results: list[QuotaReport | None] = [None] * len(records)
        completed = 0
        for future in as_completed(future_to_index):
            index = future_to_index[future]
            report = future.result()
            results[index] = report
            completed += 1
            if progress_fn is not None:
                progress_fn(report, completed, len(records))
        return [report for report in results if report is not None]


def load_cached_records_from_json(raw: str) -> list[AuthRecord]:
    """桌面端把缓存账号 JSON 回填成 AuthRecord。"""

    if not clean_str(raw):
        raise RuntimeError("桌面端没有传入缓存账号数据")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("缓存账号数据不是合法 JSON") from exc
    if not isinstance(payload, list):
        raise RuntimeError("缓存账号数据结构不正确")
    records = build_auth_records_from_cached_items(payload)
    if not records:
        raise RuntimeError("缓存账号列表为空")
    return records


def load_cached_records_from_stdin(stdin_payload: str | None = None) -> list[AuthRecord]:
    """优先消费显式传入的缓存账号 JSON，缺省时再回退到 stdin。"""

    raw = stdin_payload if stdin_payload is not None else sys.stdin.read()
    return load_cached_records_from_json(raw)


def run_command_mode(
    args: argparse.Namespace,
    stdin_payload: str | None = None,
    progress_fn: Callable[[QuotaReport, int, int], None] | None = None,
) -> dict[str, Any]:
    """桌面端子命令统一从这里出结果 payload。"""

    base_url = resolve_base_url(args, allow_prompt=False)
    management_key = resolve_management_key(args, allow_prompt=False)
    effective_progress_fn = progress_fn if args.emit_progress else None
    if args.command == "query-records":
        records = load_cached_records_from_stdin(stdin_payload)
        return build_query_payload(
            query_reports(
                base_url,
                management_key,
                records,
                args.timeout,
                max_workers=args.max_workers,
                progress_fn=effective_progress_fn,
            )
        )
    records = load_cpa_auth_records(base_url, management_key, args.timeout)
    if args.command == "list":
        return build_list_payload(records)
    if args.command == "query-all":
        return build_query_payload(
            query_reports(
                base_url,
                management_key,
                records,
                args.timeout,
                max_workers=args.max_workers,
                progress_fn=effective_progress_fn,
            )
        )
    if args.command == "query-one":
        selected = select_records_by_auth_indexes(records, [clean_str(args.auth_index)])
        return build_query_payload(
            query_reports(
                base_url,
                management_key,
                selected,
                args.timeout,
                max_workers=args.max_workers,
                progress_fn=effective_progress_fn,
            )
        )
    if args.command == "query-many":
        selected = select_records_by_auth_indexes(records, split_auth_indexes(args.auth_index))
        return build_query_payload(
            query_reports(
                base_url,
                management_key,
                selected,
                args.timeout,
                max_workers=args.max_workers,
                progress_fn=effective_progress_fn,
            )
        )
    raise RuntimeError(f"不支持的命令: {args.command}")


def parse_worker_request(raw: str) -> tuple[str, list[str], str | None, str]:
    """把桌面端 worker 请求校验成命令、参数和可选 stdin。"""

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("worker 请求不是合法 JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("worker 请求结构不正确")
    command = clean_str(payload.get("command"))
    if not command:
        raise RuntimeError("worker 请求缺少 command")
    raw_args = payload.get("args", [])
    if not isinstance(raw_args, list) or any(not isinstance(item, str) for item in raw_args):
        raise RuntimeError("worker 请求里的 args 必须是字符串数组")
    # Rust 侧请求体走 camelCase，这里保留 snake_case 兼容，避免桌面端和脚本协议漂移。
    stdin_payload = first_present(payload.get("stdin_payload"), payload.get("stdinPayload"))
    if stdin_payload is not None and not isinstance(stdin_payload, str):
        raise RuntimeError("worker 请求里的 stdin_payload 必须是字符串")
    request_id = clean_str(first_present(payload.get("request_id"), payload.get("requestId")))
    return command, raw_args, stdin_payload, request_id


def build_worker_response(
    *,
    kind: str,
    ok: bool,
    payload: dict[str, Any] | None = None,
    error_message: str = "",
) -> str:
    """worker 模式固定输出单行 JSON，方便桌面端逐条读取。"""

    body: dict[str, Any] = {"kind": kind, "ok": ok}
    if ok:
        body["payload"] = payload or {}
    else:
        body["error"] = error_message or "worker 请求失败"
    return json.dumps(body, ensure_ascii=False)


def build_worker_progress_payload(
    *,
    request_id: str,
    report: QuotaReport,
    completed: int,
    total: int,
) -> dict[str, Any]:
    """把单账号完成事件整理成桌面端可直接消费的进度结构。"""

    label = report.email or report.name
    timing_copy = describe_report_timings(report) or "总耗时 -"
    return {
        "request_id": request_id,
        "completed": completed,
        "total": total,
        "current_label": f"{label} | {timing_copy}",
        "auth_index": report.auth_index,
        "status": report.status,
        "timings_ms": dict(report.timings_ms),
    }


def run_worker_loop(input_stream: TextIO = sys.stdin, output_stream: TextIO = sys.stdout) -> int:
    """保持单个 Python 进程常驻，按行处理桌面端发来的查询请求。"""

    for raw_line in input_stream:
        if not clean_str(raw_line):
            continue
        try:
            command, raw_args, stdin_payload, request_id = parse_worker_request(raw_line)
            # worker 只接受桌面端子命令，避免意外落回交互输入。
            try:
                args = parse_args([command, *raw_args])
            except SystemExit as exc:
                raise RuntimeError(f"worker 请求参数无效: {command}") from exc
            if not args.command:
                raise RuntimeError("worker 请求缺少可执行子命令")
            payload = run_command_mode(
                args,
                stdin_payload,
                progress_fn=(
                    lambda report, completed, total: (
                        output_stream.write(
                            build_worker_response(
                                kind="progress",
                                ok=True,
                                payload=build_worker_progress_payload(
                                    request_id=request_id,
                                    report=report,
                                    completed=completed,
                                    total=total,
                                ),
                            )
                            + "\n"
                        ),
                        output_stream.flush(),
                    )
                ),
            )
            output_stream.write(build_worker_response(kind="result", ok=True, payload=payload) + "\n")
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001
            output_stream.write(build_worker_response(kind="error", ok=False, error_message=str(exc)) + "\n")
        output_stream.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    """主入口只负责交互和结果输出。"""

    force_utf8_stdio()
    raw_argv = argv or sys.argv[1:]
    if raw_argv and clean_str(raw_argv[0]).lower() == "worker":
        try:
            return run_worker_loop()
        except KeyboardInterrupt:
            print("\n已取消查询。", file=sys.stderr)
            return 130

    args = parse_args(raw_argv)
    try:
        if args.command:
            payload = run_command_mode(args)
            if args.json:
                print(payload_to_json(payload))
            else:
                reports = [
                    QuotaReport(
                        name=item["name"],
                        email=item["email"],
                        plan_type=item["plan_type"],
                        account_id=item["account_id"],
                        auth_index=item["auth_index"],
                        status=item["status"],
                        windows=[QuotaWindow(**window) for window in item.get("windows", [])],
                        additional_windows=[QuotaWindow(**window) for window in item.get("additional_windows", [])],
                        error=item.get("error", ""),
                        timings_ms=item.get("timings_ms", {}),
                    )
                    for item in payload.get("items", [])
                ]
                render_reports(reports, show_timings=args.show_timings)
            return 0

        base_url = resolve_base_url(args, allow_prompt=True)
        management_key = resolve_management_key(args, allow_prompt=True)
        load_started_at = time.perf_counter()
        records = load_cpa_auth_records(base_url, management_key, args.timeout)
        load_records_ms = round_duration_ms(load_started_at)
        selected = choose_records_interactively(records, prefetched_choice=args.select)
        batch_started_at = time.perf_counter()
        reports = query_reports(
            base_url,
            management_key,
            selected,
            args.timeout,
            max_workers=args.max_workers,
            progress_fn=print_cli_progress if args.show_timings else None,
        )
        payload = build_query_payload(reports)
        if args.json:
            print(payload_to_json(payload))
        else:
            render_reports(reports, show_timings=args.show_timings)
            if args.show_timings:
                print_cli_timing_summary(load_records_ms=load_records_ms, batch_started_at=batch_started_at, reports=reports)
        return 0
    except KeyboardInterrupt:
        print("\n已取消查询。", file=sys.stderr)
        return 130
    except RuntimeError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
