"""生图任务注册表：跟踪各画布的生成中任务与未查看的新图（红点数据源）

多画布切换工作流：
- 所有生图入口（直接 API / 右键菜单 / Agent 工具）经由 tracks_generation 装饰器接入
- 生成结束（成功/失败）end()：成功时记录未读新图，前端画布列表以红点提示
- 切换到该画布（打开会话）时 seen() 清除未读，对齐微信"点开会话即已读"心智

未读状态落盘到 backend/data/tasks.json：后端重启后红点不丢，用户仍能看到
"哪些画布有新图"。生成中的任务数（generating）不跨进程恢复，读盘时一律归零，
否则重启前崩溃的任务会让红点永远转圈。
"""
from __future__ import annotations

import functools
import json
import logging
import os
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# canvas_id -> 状态（generating: 进行中任务数；pending: 未查看新图数；last_done: 最近完成时间戳）
_tasks: dict[str, dict] = {}
_lock = threading.Lock()
_loaded = False


def _state_path() -> Path:
    """未读状态文件路径，与画布数据同目录（CANVAS_DATA_DIR 的父目录）"""
    env_dir = os.getenv("CANVAS_DATA_DIR")
    base = Path(env_dir).parent if env_dir else Path(__file__).resolve().parent.parent.parent / "data"
    return base / "tasks.json"


def _ensure_loaded() -> None:
    """首次访问时从磁盘恢复未读状态（调用方需持锁）"""
    global _loaded
    if _loaded:
        return
    _loaded = True
    path = _state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("未读状态读取失败（按空处理）: %s: %s", path.name, e)
        return
    if not isinstance(data, dict):
        return
    for cid, entry in data.items():
        if not isinstance(entry, dict):
            continue
        _tasks[cid] = {
            "generating": 0,
            "pending": int(entry.get("pending", 0) or 0),
            "last_done": float(entry.get("last_done", 0) or 0),
        }


def _persist() -> None:
    """把未读状态原子写盘（调用方需持锁）；失败仅告警，不影响内存态"""
    path = _state_path()
    tmp = path.with_suffix(".json.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(_tasks, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        logger.warning("未读状态落盘失败（仅内存生效）: %s: %s", path.name, e)
        try:
            tmp.unlink(missing_ok=True)
        except OSError as cleanup_err:
            logger.debug("未读状态临时文件清理失败: %s: %s", tmp.name, cleanup_err)


def _entry(canvas_id: str) -> dict:
    e = _tasks.get(canvas_id)
    if e is None:
        e = {"generating": 0, "pending": 0, "last_done": 0.0}
        _tasks[canvas_id] = e
    return e


def begin(canvas_id: str) -> None:
    """一个生图任务开始（所有生图入口调用）"""
    with _lock:
        _ensure_loaded()
        _entry(canvas_id)["generating"] += 1


def end(canvas_id: str, *, success: bool = True) -> None:
    """一个生图任务结束；成功时累计未读新图数"""
    with _lock:
        _ensure_loaded()
        e = _entry(canvas_id)
        if e["generating"] > 0:
            e["generating"] -= 1
        if success:
            e["pending"] += 1
            e["last_done"] = time.time()
        _persist()


def seen(canvas_id: str) -> None:
    """清除该画布的未读（切换到该画布 = 打开会话）"""
    with _lock:
        _ensure_loaded()
        e = _tasks.get(canvas_id)
        if e:
            e["pending"] = 0
            _persist()


def summary(canvas_id: str) -> dict:
    """单画布红点状态：{generating, pending}"""
    with _lock:
        _ensure_loaded()
        e = _tasks.get(canvas_id)
        if not e:
            return {"generating": 0, "pending": 0}
        return {"generating": e["generating"], "pending": e["pending"]}


def drop(canvas_id: str) -> None:
    """画布被删除时清理（避免删建同 id 之外的残留；实际 id 为 uuid 不会复用，防御性）"""
    with _lock:
        _ensure_loaded()
        _tasks.pop(canvas_id, None)
        _persist()


def tracks_generation(func):
    """生图工具 run 方法装饰器：自动 begin/end，成功时记入该画布未读。

    覆盖直接 API / 右键菜单 / Agent 工具三条路径（SSE 流式路径单独在路由层接入）。
    """

    @functools.wraps(func)
    def wrapper(self, state, **kwargs):
        canvas_id = state.canvas_id
        begin(canvas_id)
        try:
            result = func(self, state, **kwargs)
            end(canvas_id, success=bool(result.success))
            return result
        except Exception:
            logger.exception("生图任务异常（canvas=%s）", canvas_id)
            end(canvas_id, success=False)
            raise

    return wrapper
