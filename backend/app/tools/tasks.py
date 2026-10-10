"""生图任务注册表：跟踪各画布的生成中任务与未查看的新图（红点数据源）

多画布切换工作流：
- 所有生图入口（直接 API / 右键菜单 / Agent 工具）经由 tracks_generation 装饰器接入
- 生成结束（成功/失败）end()：成功时记录未读新图，前端画布列表以红点提示
- 切换到该画布（打开会话）时 seen() 清除未读，对齐微信"点开会话即已读"心智

内存态即可满足需求（后端重启丢红点无碍），不做持久化。
"""
from __future__ import annotations

import functools
import threading
import time

# canvas_id -> 状态（generating: 进行中任务数；pending: 未查看新图数；last_done: 最近完成时间戳）
_tasks: dict[str, dict] = {}
_lock = threading.Lock()


def _entry(canvas_id: str) -> dict:
    e = _tasks.get(canvas_id)
    if e is None:
        e = {"generating": 0, "pending": 0, "last_done": 0.0}
        _tasks[canvas_id] = e
    return e


def begin(canvas_id: str) -> None:
    """一个生图任务开始（所有生图入口调用）"""
    with _lock:
        _entry(canvas_id)["generating"] += 1


def end(canvas_id: str, *, success: bool = True) -> None:
    """一个生图任务结束；成功时累计未读新图数"""
    with _lock:
        e = _entry(canvas_id)
        if e["generating"] > 0:
            e["generating"] -= 1
        if success:
            e["pending"] += 1
            e["last_done"] = time.time()


def seen(canvas_id: str) -> None:
    """清除该画布的未读（切换到该画布 = 打开会话）"""
    with _lock:
        e = _tasks.get(canvas_id)
        if e:
            e["pending"] = 0


def summary(canvas_id: str) -> dict:
    """单画布红点状态：{generating, pending}"""
    with _lock:
        e = _tasks.get(canvas_id)
        if not e:
            return {"generating": 0, "pending": 0}
        return {"generating": e["generating"], "pending": e["pending"]}


def drop(canvas_id: str) -> None:
    """画布被删除时清理（避免删建同 id 之外的残留；实际 id 为 uuid 不会复用，防御性）"""
    with _lock:
        _tasks.pop(canvas_id, None)


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
            end(canvas_id, success=False)
            raise

    return wrapper
