#!/usr/bin/env python3
"""一键打包全部日志到项目根目录，生成 logs_YYYYmmdd_HHMMSS.zip。

收集范围：
- backend/data/logs/app.log、debug.log 及其轮转文件
- backend/data/llm_logs/context_*.jsonl（发送给大模型的完整上下文日志）
若设置了 CANVAS_DATA_DIR / LLM_CONTEXT_LOG_DIR，按环境变量指向的目录收集。
"""
from __future__ import annotations

import os
import sys
import time
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _stdout_utf8() -> None:
    """Windows 控制台默认编码不一定是 UTF-8，避免中文输出报错。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def log_dirs() -> list[Path]:
    """与 log_config.py / llm_logs.py 的目录解析保持一致。"""
    env_data_dir = os.getenv("CANVAS_DATA_DIR", "").strip()
    if env_data_dir:
        data_dir = Path(env_data_dir).expanduser()
        # log_config.py：自定义数据目录时，日志写在它的父目录下
        candidates = [data_dir.parent / "logs", data_dir / "llm_logs"]
    else:
        data_dir = PROJECT_ROOT / "backend" / "data"
        candidates = [data_dir / "logs", data_dir / "llm_logs"]

    env_llm_log = os.getenv("LLM_CONTEXT_LOG_DIR", "").strip()
    if env_llm_log:
        candidates.append(Path(env_llm_log).expanduser())

    unique: list[Path] = []
    for item in candidates:
        try:
            resolved = item.resolve()
        except OSError:
            continue
        if resolved not in unique:
            unique.append(resolved)
    return unique


def _arcname(path: Path) -> str:
    """压缩包内路径：项目内文件保留相对路径，项目外文件放到 external/ 下。"""
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return f"external/{path.parent.name}/{path.name}"


def collect(directories: list[Path]) -> list[tuple[Path, str]]:
    entries: list[tuple[Path, str]] = []
    seen: set[Path] = set()
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            entries.append((path, _arcname(path)))
    return entries


def main() -> int:
    _stdout_utf8()
    directories = log_dirs()
    entries = collect(directories)

    if not entries:
        print("没有找到可打包的日志文件，已检查以下目录：")
        for directory in directories:
            print(f"  - {directory}")
        return 1

    zip_path = PROJECT_ROOT / f"logs_{time.strftime('%Y%m%d_%H%M%S')}.zip"
    packed = 0
    total_bytes = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, arcname in entries:
            try:
                total_bytes += path.stat().st_size
                archive.write(path, arcname)
                packed += 1
            except OSError as exc:
                # 日志正被写入/轮转时可能短暂无法读取，跳过即可
                print(f"跳过无法读取的文件: {path} ({exc})")

    if packed == 0:
        zip_path.unlink(missing_ok=True)
        print("日志文件均无法读取（可能被占用），未生成压缩包。")
        return 1

    print(f"已打包 {packed} 个日志文件（原始 {total_bytes / 1024 / 1024:.2f} MB）")
    print(f"压缩包: {zip_path}（{zip_path.stat().st_size / 1024 / 1024:.2f} MB）")
    if packed < len(entries):
        print(f"有 {len(entries) - packed} 个文件被占用而跳过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
