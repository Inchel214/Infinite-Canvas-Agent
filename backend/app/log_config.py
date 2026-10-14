"""日志系统配置：控制台 + 滚动文件双通道

单一日志文件 backend/data/logs/app.log（已被 .gitignore 覆盖）：
后端全量日志（吞异常补记录点、uvicorn 访问/错误日志）与前端上报日志
（/api/client_logs）合流写入，行内 [frontend] 标记区分来源，
时间戳统一便于前后端问题对照排查。
"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 滚动策略：单文件 10MB，保留 5 个备份
_MAX_BYTES = 10 * 1024 * 1024
_BACKUP_COUNT = 5

# 幂等标记：main.py 模块级别调用一次，多入口导入时防止重复挂 handler
_configured = False


def _logs_dir() -> Path:
    """日志目录跟随 CANVAS_DATA_DIR（与画布数据同目录策略），默认 backend/data/logs"""
    env_dir = os.getenv("CANVAS_DATA_DIR")
    if env_dir:
        return Path(env_dir).parent / "logs"
    return Path(__file__).resolve().parent.parent / "data" / "logs"


def _file_handler(path: Path) -> RotatingFileHandler:
    path.parent.mkdir(parents=True, exist_ok=True)
    h = RotatingFileHandler(
        path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
    )
    h.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT))
    return h


def setup_logging() -> Path:
    """初始化全局日志（幂等）。返回日志目录，便于启动提示。"""
    global _configured
    logs_dir = _logs_dir()
    if _configured:
        return logs_dir
    _configured = True

    formatter = logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT)

    # root：控制台（INFO）+ 文件（INFO），未显式配置的模块 logger 全部落到这里
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)
    root.addHandler(console)
    app_file = _file_handler(logs_dir / "app.log")
    app_file.setLevel(logging.INFO)
    root.addHandler(app_file)

    # uvicorn 自带 logger 有独立 handler 且不向 root 传播：手动挂同一文件 handler，
    # 采集访问日志（uvicorn.access，propagate=False）与启动/异常日志（uvicorn）。
    # 注意 uvicorn.error 无独立 handler、默认冒泡到 "uvicorn"，这里不能再给它挂，
    # 否则同一条启动/异常日志写两遍。
    for name in ("uvicorn", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.addHandler(app_file)

    # 前端上报日志不单独设 handler：logger 名为 "frontend"（见 routes.py），
    # 默认冒泡到 root → 与后端日志合流写 app.log，行内 [frontend] 标记来源

    logging.getLogger(__name__).info("日志系统已初始化，目录: %s", logs_dir)
    return logs_dir
