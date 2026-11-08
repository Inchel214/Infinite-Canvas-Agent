"""每画布 Agent 请求调度器：串行执行 + 排队 + 工具边界 steering 注入。

背景：/agent/chat/stream 原本每个请求直接启动独立 worker 线程，没有任何并发控制；
前端又用 sending 阻塞输入，导致"执行中无法继续发消息"。

本模块把每画布的执行收拢为一条串行流水线：

- submit：画布空闲则立即启动 worker 执行；忙碌则请求排队（SSE 连接挂起等待）
- 排队请求的两种消费时机：
  1. steering 注入：当前 run 的工具边界（下一次 LLM 调用前）注入对话，
     Agent 同一回合内即可响应新指令（Claude Code / Cursor 模式）
  2. 队列推进：当前 run 结束时队列仍非空，取队首开始新 run
- 事件路由：run 期间产生的事件广播给所有订阅者（发起者 + 被 steering 注入者），
  同时写入事件缓冲（切换画布回放用）

请求到达即持久化用户消息，客户端断开不影响执行（与既有"断开继续执行"语义一致）。
"""
from __future__ import annotations

import itertools
import logging
import queue
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field

from app.agent.sessions import ChatSessionStore, format_failure_note

logger = logging.getLogger(__name__)


@dataclass
class Submitted:
    """一个已提交的用户请求（一个 SSE 连接对应一个 Submitted）"""

    prompt: str
    referenced_images: list[dict] | None
    evq: "queue.Queue[dict | None]" = field(default_factory=queue.Queue)
    queued: bool = False  # 提交时是否在排队（决定 SSE 是否先发 queued 事件）
    position: int = 0  # 排队位置（1 起；0 表示立即执行）


class CanvasDispatcher:
    """每画布串行执行 Agent 任务：排队 + steering 注入 + 事件广播"""

    def __init__(self, agent, chat_sessions: ChatSessionStore):
        self._agent = agent
        self._chat_sessions = chat_sessions
        self._lock = threading.Lock()
        self._pending: dict[str, deque[Submitted]] = {}
        self._active: set[str] = set()
        # 全局单调递增事件序号：同一面板多条并发 SSE 连接（steering 注入后
        # 广播给多个订阅者）时，前端据此去重，避免重复消费同一事件。
        # _boot 标识本次后端进程启动：重启后序号归零，前端检测到 _boot 变化
        # 时重置去重水位，避免旧水位把新序号全部误跳过
        self._seq = itertools.count(1)
        self._boot = uuid.uuid4().hex[:8]

    def submit(
        self,
        canvas_id: str,
        prompt: str,
        referenced_images: list[dict] | None = None,
        round_id: str | None = None,
        pre_canvas: dict | None = None,
    ) -> Submitted:
        """提交一个用户请求：空闲立即执行，忙碌进入队列。

        用户消息在提交时立即持久化（到达即落盘，断开连接/刷新不丢；
        被 steering 消费时再补 steered_run_id 标记）。
        round_id/pre_canvas 随消息落盘，供刷新或后端重启后整轮回退。
        """
        self._chat_sessions.append_user_message(
            canvas_id, prompt, round_id=round_id, pre_canvas=pre_canvas
        )
        sub = Submitted(prompt=prompt, referenced_images=referenced_images)
        start_worker = False
        with self._lock:
            if canvas_id in self._active:
                pend = self._pending.setdefault(canvas_id, deque())
                pend.append(sub)
                sub.queued = True
                sub.position = len(pend)
                logger.info(
                    "[Dispatcher] 请求排队 canvas=%s position=%d prompt=%s",
                    canvas_id, sub.position, prompt[:60].replace("\n", " "),
                )
            else:
                self._active.add(canvas_id)
                start_worker = True
        if start_worker:
            threading.Thread(
                target=self._worker,
                args=(canvas_id, sub),
                daemon=True,
                name=f"agent-dispatch-{canvas_id[:8]}",
            ).start()
        return sub

    def _worker(self, canvas_id: str, first: Submitted) -> None:
        """串行处理请求：执行完一个，队列非空则取下一个继续"""
        current: Submitted | None = first
        try:
            while current is not None:
                subs: list[Submitted] = [current]
                # 新 run 开始：重置事件缓冲（steering 注入不重置，同一 run 事件连续）
                self._chat_sessions.begin_live(canvas_id)

                def on_event(evt: dict, _subs=subs) -> None:
                    evt = {**evt, "_seq": next(self._seq), "_boot": self._boot}
                    self._chat_sessions.append_live_event(canvas_id, evt)
                    for s in _subs:
                        s.evq.put(evt)

                # 新一轮开始：通知订阅者并写入事件缓冲。
                # 前端据此清除排队标记、开启新直播条目（队列推进场景的事件定位锚点）
                on_event({"type": "run_start", "content": current.prompt})

                def steer_provider(_subs=subs) -> dict | None:
                    """工具边界回调：取队首排队请求注入当前 run（steering）"""
                    with self._lock:
                        pend = self._pending.get(canvas_id)
                        if not pend:
                            return None
                        nxt = pend.popleft()
                    _subs.append(nxt)
                    logger.info(
                        "[Dispatcher] steering 注入排队消息 canvas=%s prompt=%s",
                        canvas_id, nxt.prompt[:60].replace("\n", " "),
                    )
                    return {
                        "prompt": nxt.prompt,
                        "referenced_images": nxt.referenced_images,
                    }

                # history / failure_note 在 run 启动时计算（此时 last_run 才准确，
                # 提前到请求到达时计算会被前一个 run 的结果污染）
                history = self._chat_sessions.get_context(canvas_id)
                failure_note = format_failure_note(
                    self._chat_sessions.last_run(canvas_id)
                )
                try:
                    result = self._agent.run(
                        current.prompt,
                        canvas_id,
                        history=history,
                        on_event=on_event,
                        failure_note=failure_note,
                        referenced_images=current.referenced_images,
                        steer_provider=steer_provider,
                    )
                    self._chat_sessions.append_assistant_message(
                        canvas_id, result.message, run_id=result.run_id
                    )
                    done_evt = {
                        "type": "done",
                        "success": result.success,
                        "stopped": result.stopped,
                        "message": result.message,
                        "canvas": result.state.to_dict(),
                        "steps": result.steps,
                    }
                    on_event(done_evt)
                except Exception as e:
                    # worker 异常也必须发 done，否则前端会一直等
                    logger.exception("Agent 执行异常 canvas=%s", canvas_id)
                    msg = f"Agent 执行失败：{e}"
                    try:
                        last_run = self._chat_sessions.last_run(canvas_id)
                        failed_run_id = None
                        if last_run and last_run.get("status") == "in_progress":
                            self._chat_sessions.finish_run(
                                canvas_id, last_run["id"], "failed", msg, error=str(e)
                            )
                            failed_run_id = last_run["id"]
                        self._chat_sessions.append_assistant_message(
                            canvas_id, msg, run_id=failed_run_id
                        )
                    except Exception:
                        logger.exception("失败轮对话落盘失败（忽略，不阻断事件流）")
                    err_evt = {
                        "type": "done",
                        "success": False,
                        "message": msg,
                        "steps": [],
                    }
                    on_event(err_evt)
                finally:
                    self._chat_sessions.finish_live(canvas_id)
                    for s in subs:
                        s.evq.put(None)

                # 队列推进：取下一个排队请求开始新 run
                with self._lock:
                    pend = self._pending.get(canvas_id)
                    current = pend.popleft() if pend else None
                    if current is None:
                        self._active.discard(canvas_id)
                    else:
                        logger.info(
                            "[Dispatcher] 队列推进 canvas=%s prompt=%s",
                            canvas_id, current.prompt[:60].replace("\n", " "),
                        )
        except Exception:
            logger.exception("Dispatcher worker 异常退出 canvas=%s", canvas_id)
            with self._lock:
                self._active.discard(canvas_id)
