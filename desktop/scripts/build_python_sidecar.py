"""把 codex_quota_checker.py 打包成桌面端可复用的 sidecar 可执行文件。"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    # npm/PowerShell 组合下容易沿用本地代码页，显式 UTF-8 避免中文构建日志乱码。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def run(command: list[str]) -> None:
    """统一执行子命令，并把失败原因原样抛出来。"""

    subprocess.run(command, check=True)


def main() -> int:
    """把 Python 查询脚本打包到 Tauri 资源目录。"""

    workspace_root = Path(__file__).resolve().parents[2]
    script_path = workspace_root / "codex_quota_checker.py"
    desktop_root = workspace_root / "desktop"
    dist_dir = desktop_root / "build" / "sidecar"
    work_dir = desktop_root / "build" / "pyinstaller-work"
    spec_dir = desktop_root / "build" / "pyinstaller-spec"
    output_dir = desktop_root / "src-tauri" / "bin"
    output_dir.mkdir(parents=True, exist_ok=True)

    sidecar_name = "codex_quota_checker_sidecar"
    try:
        run([sys.executable, "-m", "PyInstaller", "--version"])
    except subprocess.CalledProcessError as error:
        # PyInstaller 是构建期依赖；运行端不会依赖 Python。
        raise SystemExit("缺少 PyInstaller，请先执行: python -m pip install pyinstaller") from error

    run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--name",
            sidecar_name,
            "--distpath",
            str(dist_dir),
            "--workpath",
            str(work_dir),
            "--specpath",
            str(spec_dir),
            str(script_path),
        ]
    )

    built_file = dist_dir / f"{sidecar_name}.exe"
    target_file = output_dir / built_file.name
    shutil.copy2(built_file, target_file)
    print(f"已生成 sidecar: {target_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
