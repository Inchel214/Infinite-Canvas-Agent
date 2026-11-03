"""日志系统配置：控制台 + 滚动文件双通道 + 调试日志独立文件

三级日志文件：
- app.log（INFO）：运维级——任务开始/完成/失败、错误异常、关键状态变更
- debug.log（DEBUG）：开发级——Agent 全链路（system prompt、规划路由、LLM 请求/响应、
  工具参数、风格库加载等），用于排查效果问题和性能瓶颈
- 控制台（INFO）：与 app.log 同步，方便开发时实时观察

uvicorn access 日志（每 2-3 秒的轮询请求）只输出到控制台，不写文件，
避免冲刷有价值的业务日志。
"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 滚动策略：app.log 10MB×5 份；debug.log 20MB×3 份（调试日志量大，单文件更大）
_APP_MAX_BYTES = 10 * 1024 * 1024
_APP_BACKUP_COUNT = 5
_DEBUG_MAX_BYTES = 20 * 1024 * 1024
_DEBUG_BACKUP_COUNT = 3

# 幂等标记：main.py 模块级别调用一次，多入口导入时防止重复挂 handler
_configured = False


def _logs_dir() -> Path:
    """日志目录跟随 CANVAS_DATA_DIR（与画布数据同目录策略），默认 backend/data/logs"""
    env_dir = os.getenv("CANVAS_DATA_DIR")
    if env_dir:
        return Path(env_dir).parent / "logs"
    return Path(__file__).resolve().parent.parent / "data" / "logs"


def _file_handler(path: Path, max_bytes: int, backup_count: int) -> RotatingFileHandler:
    path.parent.mkdir(parents=True, exist_ok=True)
    h = RotatingFileHandler(
        path, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
    )
    h.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT))
    return h


class _AccessLogFilter(logging.Filter):
    """过滤掉 uvicorn.access 的日志，防止轮询请求冲刷文件日志"""
    def filter(self, record: logging.LogRecord) -> bool:
        return record.name != "uvicorn.access"


def setup_logging() -> Path:
    """初始化全局日志（幂等）。返回日志目录，便于启动提示。"""
    global _configured
    logs_dir = _logs_dir()
    if _configured:
        return logs_dir
    _configured = True

    formatter = logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT)

    # ===== root logger =====
    # 控制台（INFO）：开发时实时观察
    # app.log（INFO）：运维级，过滤掉 uvicorn.access
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)  # root 设为 DEBUG，让所有日志都能到达各 handler 的级别过滤

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)
    root.addHandler(console)

    app_file = _file_handler(logs_dir / "app.log", _APP_MAX_BYTES, _APP_BACKUP_COUNT)
    app_file.setLevel(logging.INFO)
    app_file.addFilter(_AccessLogFilter())  # 阻止 uvicorn.access 写入 app.log
    root.addHandler(app_file)

    # ===== debug.log：调试级，记录 Agent 全链路细节 =====
    debug_file = _file_handler(logs_dir / "debug.log", _DEBUG_MAX_BYTES, _DEBUG_BACKUP_COUNT)
    debug_file.setLevel(logging.DEBUG)
    debug_file.addFilter(_AccessLogFilter())  # 同样过滤轮询噪音
    root.addHandler(debug_file)

    # ===== uvicorn logger =====
    # uvicorn.error → 写 app.log（启动/异常日志）
    # uvicorn.access → 只走控制台（轮询请求不写文件）
    lg = logging.getLogger("uvicorn")
    lg.addHandler(app_file)

    # uvicorn.access 单独处理：只给控制台，不冒泡到 uvicorn（避免间接写文件）
    access_lg = logging.getLogger("uvicorn.access")
    access_lg.propagate = False  # 不冒泡到 "uvicorn" logger
    access_lg.addHandler(console)  # 只输出到控制台

    # 前端上报日志不单独设 handler：logger 名为 "frontend"（见 routes.py），
    # 默认冒泡到 root → 与后端日志合流写 app.log + debug.log，行内 [frontend] 标记来源

    logging.getLogger(__name__).info("日志系统已初始化，目录: %s", logs_dir)
    return logs_dir
