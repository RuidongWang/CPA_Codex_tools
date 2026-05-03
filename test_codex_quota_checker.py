"""CPA-only 版 Codex 额度查询脚本的最小回归测试。"""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock

from codex_quota_checker import (
    AuthRecord,
    apply_downloaded_auth_payload,
    build_auth_records_from_auth_files,
    build_auth_records_from_cached_items,
    build_list_payload,
    build_management_headers,
    build_query_payload,
    build_wham_api_call_payload,
    choose_records_interactively,
    extract_codex_claims,
    load_cached_records_from_json,
    load_cpa_auth_records,
    parse_args,
    parse_codex_windows,
    parse_worker_request,
    query_reports,
    QuotaReport,
    QuotaWindow,
    resolve_base_url,
    run_worker_loop,
)


def make_jwt(payload: dict) -> str:
    """构造只用于测试的 JWT 字符串。"""

    header = {"alg": "none", "typ": "JWT"}
    encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode("utf-8")).decode("utf-8").rstrip("=")
    return f"{encode(header)}.{encode(payload)}.signature"


class CodexQuotaCheckerTests(unittest.TestCase):
    """覆盖 CPA-only 方案的核心解析逻辑。"""

    def test_extract_codex_claims_from_jwt(self) -> None:
        """JWT 里的账号字段应该能稳定提取。"""

        token = make_jwt(
            {
                "email": "demo@example.com",
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-123",
                    "chatgpt_plan_type": "team",
                },
            }
        )

        claims = extract_codex_claims(token)

        self.assertEqual(claims["email"], "demo@example.com")
        self.assertEqual(claims["account_id"], "acct-123")
        self.assertEqual(claims["plan_type"], "team")

    def test_build_auth_records_from_auth_files_filters_codex(self) -> None:
        """auth-files 返回里只应保留 Codex 账号。"""

        token = make_jwt(
            {
                "email": "cpa@example.com",
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-cpa",
                    "chatgpt_plan_type": "free",
                },
            }
        )

        records = build_auth_records_from_auth_files(
            [
                {
                    "provider": "codex",
                    "name": "codex-a.json",
                    "auth_index": "idx-a",
                    "priority": 77,
                    "id_token": token,
                },
                {
                    "provider": "gemini-cli",
                    "name": "gemini-a.json",
                    "auth_index": "idx-b",
                },
            ]
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].name, "codex-a.json")
        self.assertEqual(records[0].email, "cpa@example.com")
        self.assertEqual(records[0].account_id, "acct-cpa")
        self.assertEqual(records[0].auth_index, "idx-a")
        self.assertEqual(records[0].priority, 77)

    def test_build_auth_records_from_auth_files_reads_dict_id_token_claims(self) -> None:
        """auth-files 的 dict 版 id_token 也应直接带出 account_id。"""

        records = build_auth_records_from_auth_files(
            [
                {
                    "provider": "codex",
                    "name": "codex-dict.json",
                    "email": "dict@example.com",
                    "auth_index": "idx-dict",
                    "priority": 55,
                    "id_token": {
                        "chatgpt_account_id": "acct-dict",
                        "plan_type": "free",
                    },
                }
            ]
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].account_id, "acct-dict")
        self.assertEqual(records[0].plan_type, "free")

    def test_build_auth_records_from_cached_items_keeps_priority(self) -> None:
        """桌面端传回的缓存账号应能直接转成 AuthRecord。"""

        records = build_auth_records_from_cached_items(
            [
                {
                    "name": "codex-a.json",
                    "email": "cached@example.com",
                    "plan_type": "pro 5x",
                    "account_id": "acct-cached",
                    "auth_index": "idx-cached",
                    "priority": 66,
                }
            ]
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].plan_type, "pro 5x")
        self.assertEqual(records[0].priority, 66)

    def test_build_management_headers_keeps_bearer_and_legacy_key_header(self) -> None:
        """管理请求头应同时兼容 Bearer 和旧版 X-Management-Key。"""

        headers = build_management_headers("demo-key")

        self.assertEqual(headers["Authorization"], "Bearer demo-key")
        self.assertEqual(headers["X-Management-Key"], "demo-key")

    def test_build_wham_api_call_payload_uses_auth_index_and_account_id(self) -> None:
        """api-call 负载应固定走 auth_index 和 Chatgpt-Account-Id。"""

        record = AuthRecord(
            name="codex-a.json",
            email="demo@example.com",
            plan_type="free",
            account_id="acct-001",
            auth_index="idx-001",
            priority=90,
        )

        payload = build_wham_api_call_payload(record)

        self.assertEqual(payload["auth_index"], "idx-001")
        self.assertEqual(payload["url"], "https://chatgpt.com/backend-api/wham/usage")
        self.assertEqual(payload["header"]["Chatgpt-Account-Id"], "acct-001")
        self.assertIn("$TOKEN$", payload["header"]["Authorization"])

    def test_apply_downloaded_auth_payload_backfills_missing_account_id(self) -> None:
        """当 auth-files 缺少账号 ID 时，应能从下载的原始 JSON 回填。"""

        token = make_jwt(
            {
                "email": "fallback@example.com",
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-fallback",
                    "chatgpt_plan_type": "free",
                },
            }
        )
        record = AuthRecord(
            name="codex-fallback.json",
            email="",
            plan_type="unknown",
            account_id="",
            auth_index="idx-fallback",
        )

        apply_downloaded_auth_payload(
            record,
            {
                "email": "fallback@example.com",
                "account_id": "acct-fallback",
                "id_token": token,
            },
        )

        self.assertEqual(record.email, "fallback@example.com")
        self.assertEqual(record.account_id, "acct-fallback")
        self.assertEqual(record.plan_type, "free")

    def test_load_cpa_auth_records_prefetches_missing_account_id(self) -> None:
        """加载账号列表时，应先补齐缺失的 account_id，避免查询阶段再下载。"""

        token = make_jwt(
            {
                "email": "prefetch@example.com",
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-prefetch",
                    "chatgpt_plan_type": "free",
                },
            }
        )
        with mock.patch(
            "codex_quota_checker.request_json",
            return_value=(
                200,
                {
                    "files": [
                        {
                            "provider": "codex",
                            "name": "codex-prefetch.json",
                            "email": "",
                            "auth_index": "idx-prefetch",
                            "priority": 88,
                        },
                        {
                            "provider": "codex",
                            "name": "codex-ready.json",
                            "email": "ready@example.com",
                            "auth_index": "idx-ready",
                            "chatgpt_account_id": "acct-ready",
                            "priority": 66,
                        },
                    ]
                },
            ),
        ), mock.patch(
            "codex_quota_checker.download_auth_file",
            return_value={
                "email": "prefetch@example.com",
                "account_id": "acct-prefetch",
                "id_token": token,
            },
        ) as mocked_download:
            records = load_cpa_auth_records("http://example.com", "demo", 30.0)

        self.assertEqual(len(records), 2)
        self.assertEqual(records[0].account_id, "acct-prefetch")
        self.assertEqual(records[0].email, "prefetch@example.com")
        self.assertEqual(records[1].account_id, "acct-ready")
        mocked_download.assert_called_once_with("http://example.com", "demo", "codex-prefetch.json", 30.0)

    def test_parse_codex_windows(self) -> None:
        """5h / 7d 窗口应按秒数正确识别。"""

        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25,
                    "limit_window_seconds": 5 * 60 * 60,
                    "reset_at": 1735689600,
                },
                "secondary_window": {
                    "used_percent": 80,
                    "limit_window_seconds": 7 * 24 * 60 * 60,
                    "reset_after_seconds": 600,
                },
            }
        }

        windows = parse_codex_windows(payload)

        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[0].id, "code-5h")
        self.assertAlmostEqual(windows[0].remaining_percent or -1, 75.0)
        self.assertEqual(windows[1].id, "code-7d")
        self.assertAlmostEqual(windows[1].remaining_percent or -1, 20.0)

    def test_parse_codex_windows_keeps_zero_percent_and_single_week_window(self) -> None:
        """只有单个 7d 窗口且 used_percent 为 0 时，不应被复制成两个窗口。"""

        payload = {
            "rate_limit": {
                "allowed": True,
                "limit_reached": False,
                "primary_window": {
                    "used_percent": 0,
                    "limit_window_seconds": 7 * 24 * 60 * 60,
                    "reset_after_seconds": 600,
                },
                "secondary_window": None,
            }
        }

        windows = parse_codex_windows(payload)

        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].id, "code-7d")
        self.assertAlmostEqual(windows[0].remaining_percent or -1, 100.0)

    def test_choose_records_interactively_accepts_all(self) -> None:
        """交互选择应支持一次性查询全部账号。"""

        records = [
            AuthRecord(name="a.json", email="a@example.com", plan_type="free", account_id="acct-a", auth_index="idx-a", priority=99),
            AuthRecord(name="b.json", email="b@example.com", plan_type="team", account_id="acct-b", auth_index="idx-b", priority=80),
        ]

        chosen = choose_records_interactively(records, input_fn=lambda _: "all", output_fn=lambda _: None)

        self.assertEqual([item.name for item in chosen], ["a.json", "b.json"])

    def test_build_list_payload_groups_unknown_records(self) -> None:
        """桌面端列表接口应返回基础分组统计。"""

        records = [
            AuthRecord(name="a.json", email="a@example.com", plan_type="free", account_id="acct-a", auth_index="idx-a", priority=99),
            AuthRecord(name="b.json", email="b@example.com", plan_type="team", account_id="acct-b", auth_index="idx-b", priority=80),
        ]

        payload = build_list_payload(records)

        self.assertEqual(payload["meta"]["total"], 2)
        self.assertEqual(payload["groups"]["by_plan"]["free"], 1)
        self.assertEqual(payload["groups"]["by_plan"]["team"], 1)
        self.assertEqual(payload["groups"]["by_status"]["unknown"], 2)
        self.assertEqual(payload["items"][0]["status"], "unknown")
        self.assertEqual(payload["items"][0]["priority"], 99)

    def test_build_query_payload_marks_low_and_error(self) -> None:
        """桌面端查询接口应能统一归类 low 和 error。"""

        reports = [
            QuotaReport(
                name="a.json",
                email="a@example.com",
                plan_type="free",
                account_id="acct-a",
                auth_index="idx-a",
                status="",
                priority=99,
                windows=[
                    QuotaWindow(
                        id="code-7d",
                        label="代码 7d",
                        used_percent=90.0,
                        remaining_percent=10.0,
                        reset_label="-",
                        exhausted=False,
                    )
                ],
            ),
            QuotaReport(
                name="b.json",
                email="b@example.com",
                plan_type="team",
                account_id="acct-b",
                auth_index="idx-b",
                status="",
                priority=80,
                error="bad request",
            ),
        ]

        payload = build_query_payload(reports)

        self.assertEqual(payload["meta"]["total"], 2)
        self.assertEqual(payload["meta"]["success"], 1)
        self.assertEqual(payload["meta"]["failed"], 1)
        self.assertEqual(payload["groups"]["by_status"]["low"], 1)
        self.assertEqual(payload["groups"]["by_status"]["error"], 1)
        self.assertEqual(payload["items"][0]["priority"], 99)

    def test_build_query_payload_uses_5h_reset_label_as_quota_updated_at(self) -> None:
        """额度更新时间列应取 5h 额度里的下次刷新时间。"""

        reports = [
            QuotaReport(
                name="a.json",
                email="a@example.com",
                plan_type="free",
                account_id="acct-a",
                auth_index="idx-a",
                status="",
                priority=99,
                windows=[
                    QuotaWindow(
                        id="code-5h",
                        label="代码 5h",
                        used_percent=0.0,
                        remaining_percent=100.0,
                        reset_label="05-03 18:53",
                        exhausted=False,
                    ),
                    QuotaWindow(
                        id="code-7d",
                        label="代码 7d",
                        used_percent=20.0,
                        remaining_percent=80.0,
                        reset_label="05-06 10:13",
                        exhausted=False,
                    ),
                ],
            )
        ]

        payload = build_query_payload(reports)

        self.assertEqual(payload["items"][0]["quota_updated_at"], "05-03 18:53")

    def test_query_reports_runs_in_parallel_and_keeps_order(self) -> None:
        """批量查询应并发执行，同时保持返回顺序稳定。"""

        records = [
            AuthRecord(name="a.json", email="a@example.com", plan_type="free", account_id="acct-a", auth_index="idx-a", priority=99),
            AuthRecord(name="b.json", email="b@example.com", plan_type="free", account_id="acct-b", auth_index="idx-b", priority=98),
            AuthRecord(name="c.json", email="c@example.com", plan_type="free", account_id="acct-c", auth_index="idx-c", priority=97),
        ]

        def fake_query(base_url: str, management_key: str, record: AuthRecord, timeout: float) -> QuotaReport:
            time.sleep(0.2)
            return QuotaReport(
                name=record.name,
                email=record.email,
                plan_type=record.plan_type,
                account_id=record.account_id,
                auth_index=record.auth_index,
                status="healthy",
                priority=record.priority,
            )

        started_at = time.perf_counter()
        reports = query_reports("http://example.com", "demo", records, 30.0, query_fn=fake_query, max_workers=3)
        elapsed = time.perf_counter() - started_at

        self.assertLess(elapsed, 0.45)
        self.assertEqual([report.name for report in reports], ["a.json", "b.json", "c.json"])

    def test_query_reports_emits_incremental_progress(self) -> None:
        """批量查询完成一个账号后就应回调一次进度。"""

        records = [
            AuthRecord(name="a.json", email="a@example.com", plan_type="free", account_id="acct-a", auth_index="idx-a", priority=99),
            AuthRecord(name="b.json", email="b@example.com", plan_type="free", account_id="acct-b", auth_index="idx-b", priority=98),
            AuthRecord(name="c.json", email="c@example.com", plan_type="free", account_id="acct-c", auth_index="idx-c", priority=97),
        ]
        progress_steps: list[tuple[int, int, str]] = []

        def fake_query(base_url: str, management_key: str, record: AuthRecord, timeout: float) -> QuotaReport:
            delays = {
                "idx-a": 0.18,
                "idx-b": 0.05,
                "idx-c": 0.11,
            }
            time.sleep(delays[record.auth_index])
            return QuotaReport(
                name=record.name,
                email=record.email,
                plan_type=record.plan_type,
                account_id=record.account_id,
                auth_index=record.auth_index,
                status="healthy",
                priority=record.priority,
            )

        query_reports(
            "http://example.com",
            "demo",
            records,
            30.0,
            query_fn=fake_query,
            max_workers=3,
            progress_fn=lambda report, completed, total: progress_steps.append((completed, total, report.auth_index)),
        )

        self.assertEqual(progress_steps, [(1, 3, "idx-b"), (2, 3, "idx-c"), (3, 3, "idx-a")])

    def test_load_cached_records_from_json_accepts_cached_items(self) -> None:
        """worker 显式传入的缓存账号 JSON 应能直接复用。"""

        records = load_cached_records_from_json(
            json.dumps(
                [
                    {
                        "name": "cached.json",
                        "email": "cached@example.com",
                        "plan_type": "free",
                        "account_id": "acct-cached",
                        "auth_index": "idx-cached",
                        "priority": 70,
                    }
                ]
            )
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].auth_index, "idx-cached")
        self.assertEqual(records[0].account_id, "acct-cached")

    def test_parse_worker_request_reads_command_and_payload(self) -> None:
        """worker 请求应能拆出命令、参数和 stdin 负载。"""

        command, args, stdin_payload, request_id = parse_worker_request(
            json.dumps(
                {
                    "command": "query-records",
                    "args": ["--json", "--management-key", "example-management-key"],
                    "stdin_payload": "[{\"auth_index\":\"idx-a\"}]",
                    "requestId": "req-1",
                }
            )
        )

        self.assertEqual(command, "query-records")
        self.assertEqual(args, ["--json", "--management-key", "example-management-key"])
        self.assertEqual(stdin_payload, "[{\"auth_index\":\"idx-a\"}]")
        self.assertEqual(request_id, "req-1")

    def test_parse_worker_request_accepts_camel_case_stdin_payload(self) -> None:
        """桌面端发来的 camelCase 字段也应能被 worker 识别。"""

        _command, _args, stdin_payload, _request_id = parse_worker_request(
            json.dumps(
                {
                    "command": "query-records",
                    "args": ["--json"],
                    "stdinPayload": "[{\"auth_index\":\"idx-a\"}]",
                }
            )
        )

        self.assertEqual(stdin_payload, "[{\"auth_index\":\"idx-a\"}]")

    def test_run_worker_loop_returns_error_envelope_for_bad_request(self) -> None:
        """坏请求不应杀掉 worker，而应回错误包。"""

        input_stream = io.StringIO("{\"command\":\"\"}\n")
        output_stream = io.StringIO()

        exit_code = run_worker_loop(input_stream, output_stream)

        self.assertEqual(exit_code, 0)
        response = json.loads(output_stream.getvalue().strip())
        self.assertEqual(response["kind"], "error")
        self.assertFalse(response["ok"])
        self.assertIn("worker 请求缺少 command", response["error"])

    def test_worker_process_emits_utf8_json_without_python_utf8_env(self) -> None:
        """即使宿主进程没开 UTF-8 模式，worker 返回给桌面端的 JSON 也必须是 UTF-8。"""

        script_path = Path(__file__).resolve().with_name("codex_quota_checker.py")
        env = os.environ.copy()
        env.pop("PYTHONUTF8", None)
        env.pop("PYTHONIOENCODING", None)

        completed = subprocess.run(
            [sys.executable, str(script_path), "worker"],
            input=b"{\"command\":\"\"}\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=env,
        )

        self.assertEqual(completed.returncode, 0)
        response = json.loads(completed.stdout.decode("utf-8").strip())
        self.assertEqual(response["kind"], "error")
        self.assertFalse(response["ok"])
        self.assertIn("worker 请求缺少 command", response["error"])

    def test_parse_args_supports_desktop_subcommands(self) -> None:
        """桌面端模式需要稳定识别 list 子命令。"""

        args = parse_args(["list", "--json", "--cpa-base-url", "https://cpa.example/"])

        self.assertEqual(args.command, "list")
        self.assertTrue(args.json)
        self.assertEqual(args.cpa_base_url, "https://cpa.example/")

    def test_parse_args_supports_query_records(self) -> None:
        """桌面端缓存查询命令应能稳定识别。"""

        args = parse_args(["query-records", "--json", "--cpa-base-url", "https://cpa.example/"])

        self.assertEqual(args.command, "query-records")
        self.assertTrue(args.json)

    def test_resolve_base_url_requires_explicit_value_in_noninteractive_mode(self) -> None:
        """非交互模式不应再偷偷兜底到开发期本地地址。"""

        args = parse_args(["list", "--json"])

        with self.assertRaisesRegex(RuntimeError, "缺少 CPA 地址"):
            resolve_base_url(args, allow_prompt=False)

    def test_parse_args_supports_interactive_multi_select_and_timings(self) -> None:
        """手动测试时应能通过根命令参数指定多个编号并打开耗时打印。"""

        args = parse_args(["--select", "1,3,5", "--show-timings"])

        self.assertIsNone(args.command)
        self.assertEqual(args.select, "1,3,5")
        self.assertTrue(args.show_timings)


if __name__ == "__main__":
    unittest.main()
