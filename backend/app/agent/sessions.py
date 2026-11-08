"""Agent 对话历史存储（内存 + 文件持久化，按画布隔离）

每份画布对应一份会话文件 backend/data/chats/{canvas_id}.json，包含两部分：

- messages：用户原文与 Agent 最终回复（user/assistant 文本对），保持轻量、可直接回注 LLM 上下文
- runs：每轮执行的结构化记录（状态/计划/工具参数），供"重试/继续"精确重放失败任务

工具调用的完整过程实时持久化（每个工具步骤完成后立即写入），重启后可审计/恢复 Agent 决策过程。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# 每画布最多保留的消息条数（一对 user/assistant 算两条），超出丢弃最早
_MAX_MESSAGES = 200

# 每次注入 LLM 上下文的历史尾部条数（防止上下文爆炸）
_MAX_CONTEXT_MESSAGES = 20

# 每画布保留的执行记录条数（超出丢弃最早）
_MAX_RUNS = 50

# 可整段合并的流式增量事件：连续同类增量合并成一条，避免逐 token 存事件
_COALESCE_TYPES = ("delta", "reasoning_delta", "plan_delta")


def format_failure_note(run: dict | None) -> str | None:
    """把最近一条未完成的执行记录压缩成上下文提示，供 Agent 精确重放。

    包含完整的执行历史（成功+失败步骤），让 LLM 知道哪些步骤已完成、
    哪些失败，从而能从失败点精确重试，避免重复执行已成功的步骤。

    仅在最近一轮确实失败/停止时返回；成功轮返回 None，
    避免"上次任务已完成"的记录误导后续无关指令。
    """
    if not run or run.get("status") not in ("failed", "stopped"):
        return None

    def clip(text: object, n: int) -> str:
        s = str(text or "").replace("\n", " ").strip()
        return s if len(s) <= n else s[:n] + "…"

    status = "已停止" if run.get("status") == "stopped" else "失败"
    lines = [f"[系统记录] 本画布最近一次未完成的任务（{status}）："]
    lines.append(f"- 指令：{clip(run.get('prompt'), 120)}")
    if run.get("plan"):
        lines.append(f"- 计划：{clip(run['plan'], 120)}")

    # 包含所有步骤（成功+失败），让 LLM 知道完整执行历史
    steps = run.get("steps", [])
    if steps:
        lines.append("- 执行历史：")
        for i, step in enumerate(steps, 1):
            tool_status = "✓" if step.get("success", True) else "✗"
            args = json.dumps(step.get("args") or {}, ensure_ascii=False)
            lines.append(f"  {i}. [{tool_status}] {step.get('tool')}({clip(args, 100)})")
            if not step.get("success", True):
                lines.append(f"     失败原因：{clip(step.get('result'), 80)}")

    if run.get("error"):
        lines.append(f"- 错误：{clip(run['error'], 120)}")
    lines.append(
        "\n请从失败的步骤继续重试，已完成的步骤无需重复执行。不要重新询问用户参数。"
    )
    return "\n".join(lines)


class ChatSessionStore:
    """按画布维护 Agent 对话历史：内存缓存 + 磁盘懒加载/落盘"""

    def __init__(self, data_dir: str | None = None):
        if data_dir is None:
            data_dir = os.getenv("CHAT_DATA_DIR")
        if data_dir is None:
            data_dir = str(Path(__file__).resolve().parent.parent.parent / "data" / "chats")
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, list[dict]] = {}
        # canvas_id -> 执行记录（每轮一条：状态/计划/工具参数），与 messages 同文件
        self._runs: dict[str, list[dict]] = {}
        # canvas_id -> 当前/最近一轮的流式事件缓冲（仅内存）。
        # 前端切换画布会断开 SSE，靠这份缓冲回放"计划/思考/工具过程"，
        # 否则这些内容只存在于前端内存，切回后必然丢失。
        self._live: dict[str, dict] = {}
        # 全局锁：Agent worker 线程与 SSE 线程并发读写同一 canvas 的消息/步骤时，
        # 不加锁会出现消息丢失或 run 步骤错乱。RLock 允许同线程内 _ensure_loaded→_save 重入。
        self._lock = threading.RLock()

    def _path(self, canvas_id: str) -> Path:
        # canvas_id 为 uuid，直接作文件名
        return self._data_dir / f"{canvas_id}.json"

    def _ensure_loaded(self, canvas_id: str) -> None:
        """懒加载画布会话（messages + runs），读取失败按空处理"""
        if canvas_id in self._sessions:
            return
        path = self._path(canvas_id)
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                self._sessions[canvas_id] = data.get("messages", [])
                self._runs[canvas_id] = data.get("runs", [])
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("对话历史读取失败（按空处理）: %s: %s", path.name, e)
                self._sessions[canvas_id] = []
                self._runs[canvas_id] = []
        else:
            self._sessions[canvas_id] = []
            self._runs[canvas_id] = []

    def get_messages(self, canvas_id: str) -> list[dict]:
        """全量历史（前端展示用），返回副本防止外部改写内部状态"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            return copy.deepcopy(self._sessions[canvas_id])

    def get_context(self, canvas_id: str) -> list[dict]:
        """注入 LLM 的历史尾部（最近 _MAX_CONTEXT_MESSAGES 条），防止上下文爆炸"""
        with self._lock:
            msgs = self.get_messages(canvas_id)
            total = len(msgs)
            if total > _MAX_CONTEXT_MESSAGES:
                msgs = msgs[-_MAX_CONTEXT_MESSAGES:]
            # 只回注 role/content：round_id/pre_canvas/steered_run_id 是前端渲染与
            # 回退用的元数据，混进上下文会污染提示词甚至被严格校验的接口拒绝
            ctx = [
                {"role": m.get("role"), "content": m.get("content", "")}
                for m in msgs
            ]
            logger.debug(
                "[Session] 上下文注入 canvas=%s | 总历史=%d条 | 注入=%d条",
                canvas_id, total, len(ctx),
            )
            return ctx

    def append_user_message(
        self,
        canvas_id: str,
        user_message: str,
        round_id: str | None = None,
        pre_canvas: dict | None = None,
    ) -> None:
        """立即保存用户消息（发送时调用，确保切换画布后历史不丢失）。

        round_id + pre_canvas 供"整轮回退"：本轮开始前的画布快照随消息落盘，
        即使后端重启（内存 undo 栈丢失）也能回到本轮之前的状态。
        """
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            record: dict = {"role": "user", "content": user_message}
            if round_id:
                record["round_id"] = round_id
                if pre_canvas is not None:
                    record["pre_canvas"] = pre_canvas
            msgs.append(record)
            # 超限丢弃最早的消息
            if len(msgs) > _MAX_MESSAGES:
                del msgs[: len(msgs) - _MAX_MESSAGES]
            logger.debug(
                "[Session] 保存用户消息 canvas=%s | 当前=%d条 | round=%s | user=%s",
                canvas_id, len(msgs), round_id, user_message[:60].replace("\n", " "),
            )
            self._save(canvas_id)

    def get_round_pre_canvas(self, canvas_id: str, round_id: str) -> dict | None:
        """按 round_id 取该轮开始前的画布快照（整轮回退的后备依据）"""
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            for msg in reversed(msgs):
                if msg.get("role") == "user" and msg.get("round_id") == round_id:
                    pre = msg.get("pre_canvas")
                    return copy.deepcopy(pre) if pre else None
            return None

    def delete_round_from(self, canvas_id: str, round_id: str) -> bool:
        """撤回该轮：截断对话历史中该用户消息及其之后的所有消息与执行记录。

        与画布回退语义保持一致（回到本轮开始前的状态），因此被撤回轮次之后
        的对话也一并丢弃；前端随后把该条输入放回编辑框供修改后重发。
        """
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            cut_at = next(
                (
                    i
                    for i, m in enumerate(msgs)
                    if m.get("role") == "user" and m.get("round_id") == round_id
                ),
                None,
            )
            if cut_at is None:
                return False
            dropped = msgs[cut_at:]
            # 被截断消息关联的 run（含 steering 注入产生的 run 标记）
            run_ids = {m.get("run_id") for m in dropped if m.get("run_id")}
            run_ids |= {m.get("steered_run_id") for m in dropped if m.get("steered_run_id")}
            del msgs[cut_at:]
            runs = self._runs.get(canvas_id)
            if runs:
                first = next(
                    (i for i, r in enumerate(runs) if r.get("id") in run_ids), None
                )
                if first is not None:
                    del runs[first:]
            logger.debug(
                "[Session] 撤回轮次 canvas=%s | round=%s | 移除消息=%d条 | 剩余=%d条",
                canvas_id, round_id, len(dropped), len(msgs),
            )
            self._save(canvas_id)
            return True

    def append_assistant_message(self, canvas_id: str, assistant_message: str, run_id: str | None = None) -> None:
        """保存助手回复（worker 完成后调用）；run_id 用于前端历史重建时关联 run 的 timeline"""
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            record = {"role": "assistant", "content": assistant_message}
            if run_id:
                record["run_id"] = run_id
            msgs.append(record)
            # 超限丢弃最早的消息
            if len(msgs) > _MAX_MESSAGES:
                del msgs[: len(msgs) - _MAX_MESSAGES]
            logger.debug(
                "[Session] 保存助手回复 canvas=%s | 当前=%d条",
                canvas_id, len(msgs),
            )
            self._save(canvas_id)

    def append_round(self, canvas_id: str, user_message: str, assistant_message: str) -> None:
        """追加一轮完整对话（用户原文 + Agent 最终回复）并落盘"""
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            msgs.append({"role": "user", "content": user_message})
            msgs.append({"role": "assistant", "content": assistant_message})
            # 超限丢弃最早的消息
            if len(msgs) > _MAX_MESSAGES:
                del msgs[: len(msgs) - _MAX_MESSAGES]
            logger.debug(
                "[Session] 追加对话 canvas=%s | 当前=%d条 | user=%s",
                canvas_id, len(msgs), user_message[:60].replace("\n", " "),
            )
            self._save(canvas_id)

    def append_run(self, canvas_id: str, record: dict) -> None:
        """追加一条执行记录（状态/计划/工具参数）并落盘。

        与 messages 分离：记录不注入上下文，只在需要"重试"时被取用。
        """
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.setdefault(canvas_id, [])
            runs.append(record)
            if len(runs) > _MAX_RUNS:
                del runs[: len(runs) - _MAX_RUNS]
            self._save(canvas_id)

    def begin_run(self, canvas_id: str, prompt: str) -> str:
        """开始一轮执行，创建 in_progress 状态的 run 记录并落盘。

        返回 run_id，后续通过 update_run_steps 增量更新步骤。
        """
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.setdefault(canvas_id, [])
            run_id = uuid.uuid4().hex[:12]
            record = {
                "id": run_id,
                "at": __import__("time").time(),
                "prompt": prompt,
                "status": "in_progress",
                "plan": "",
                "steps": [],
                # 有序时间线段（plan/text/tool/user），供前端按时间线完整还原执行过程
                "timeline": [],
                "message": "",
                "error": None,
            }
            runs.append(record)
            if len(runs) > _MAX_RUNS:
                del runs[: len(runs) - _MAX_RUNS]
            self._save(canvas_id)
            logger.debug("[Session] 开始执行 canvas=%s run_id=%s", canvas_id, run_id)
            return run_id

    def update_run_plan(self, canvas_id: str, run_id: str, plan: str) -> None:
        """更新 run 记录的计划（规划阶段完成后调用）"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            for run in runs:
                if run.get("id") == run_id:
                    run["plan"] = plan
                    break
            self._save(canvas_id)

    def append_timeline_segment(self, canvas_id: str, run_id: str, segment: dict) -> None:
        """追加一个时间线段到 run 记录并立即落盘（实时持久化）。

        段类型：plan / text / tool / user，按发生顺序追加，
        前端据此把执行过程按时间线还原（工具卡片穿插在文本流中）。
        """
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            for run in runs:
                if run.get("id") == run_id:
                    run.setdefault("timeline", []).append(segment)
                    break
            self._save(canvas_id)

    def mark_user_steered(self, canvas_id: str, content: str, run_id: str) -> None:
        """给最后一条内容匹配的 user 消息打 steered_run_id 标记。

        steering 消息在请求到达时已持久化为独立 user 消息；
        被注入 run 后打上标记，前端历史渲染跳过其独立气泡，
        改由该 run 的 timeline 中的 user 锚点渲染。
        """
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            for msg in reversed(msgs):
                if msg.get("role") == "user" and msg.get("content") == content:
                    msg["steered_run_id"] = run_id
                    break
            self._save(canvas_id)

    def get_runs(self, canvas_id: str) -> list[dict]:
        """全量执行记录（前端历史时间线还原用），返回副本"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            return copy.deepcopy(self._runs.get(canvas_id, []))

    def append_step(self, canvas_id: str, run_id: str, step: dict) -> None:
        """追加一个工具步骤到 run 记录并立即落盘（实时持久化）"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            for run in runs:
                if run.get("id") == run_id:
                    run.setdefault("steps", []).append(step)
                    break
            self._save(canvas_id)
            logger.debug(
                "[Session] 追加步骤 canvas=%s run_id=%s tool=%s",
                canvas_id, run_id, step.get("tool"),
            )

    def finish_run(self, canvas_id: str, run_id: str, status: str, message: str = "", error: str | None = None) -> None:
        """完成 run 记录，更新状态为 done/failed/stopped；
        最终回复作为末尾 text 段补进 timeline（前端历史还原的收尾气泡）"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            for run in runs:
                if run.get("id") == run_id:
                    run["status"] = status
                    run["message"] = message
                    if error:
                        run["error"] = error
                    if message:
                        timeline = run.setdefault("timeline", [])
                        # 末尾已有相同文本段时不重复（如 stopped 前刚好 flush 过）
                        if not (
                            timeline
                            and timeline[-1].get("kind") == "text"
                            and timeline[-1].get("text") == message
                        ):
                            timeline.append({"kind": "text", "text": message})
                    break
            self._save(canvas_id)
            logger.debug("[Session] 完成执行 canvas=%s run_id=%s status=%s", canvas_id, run_id, status)

    def last_run(self, canvas_id: str) -> dict | None:
        """最近一条执行记录（判断"重试/继续"指向哪个任务），无记录返回 None"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            return copy.deepcopy(runs[-1]) if runs else None

    # ---------- 流式事件缓冲（切换画布回放用） ----------

    def begin_live(self, canvas_id: str) -> None:
        """新一轮执行开始：重置该画布的流式事件缓冲"""
        with self._lock:
            self._live[canvas_id] = {"events": [], "finished": False}
            logger.debug("[Live] 开始缓冲流式事件 canvas=%s", canvas_id)

    def append_live_event(self, canvas_id: str, evt: dict) -> None:
        """记录一个流式事件。

        连续的同类文本增量合并为一条，因此缓冲长度约等于"轮数×3"，
        不会因 token 级事件而无限增长。
        """
        with self._lock:
            live = self._live.get(canvas_id)
            if live is None:
                live = {"events": [], "finished": False}
                self._live[canvas_id] = live
            events: list[dict] = live["events"]
            etype = evt.get("type")
            if (
                etype in _COALESCE_TYPES
                and events
                and events[-1].get("type") == etype
            ):
                prev = events[-1]
                prev["content"] = (prev.get("content") or "") + (evt.get("content") or "")
            else:
                events.append(dict(evt))

    def finish_live(self, canvas_id: str) -> None:
        """标记缓冲已结束（前端轮询据此停止）"""
        with self._lock:
            live = self._live.get(canvas_id)
            if live is not None:
                live["finished"] = True

    def live_snapshot(self, canvas_id: str, since: int = 0) -> dict:
        """返回自 since 起的流式事件（含 cursor/finished），供前端回放/增量拉取"""
        with self._lock:
            live = self._live.get(canvas_id)
            if not live:
                return {"events": [], "cursor": 0, "finished": True}
            events = live["events"]
            start = max(0, min(since, len(events)))
            return {
                "events": copy.deepcopy(events[start:]),
                "cursor": len(events),
                "finished": live["finished"],
            }

    def clear(self, canvas_id: str) -> None:
        """清空对话历史与执行记录（内存 + 磁盘）"""
        with self._lock:
            self._sessions[canvas_id] = []
            self._runs[canvas_id] = []
            self._live.pop(canvas_id, None)
            self._save(canvas_id)

    def delete(self, canvas_id: str) -> None:
        """画布被删除时级联清理会话"""
        with self._lock:
            self._sessions.pop(canvas_id, None)
            self._runs.pop(canvas_id, None)
            self._live.pop(canvas_id, None)
            try:
                self._path(canvas_id).unlink(missing_ok=True)
            except OSError as e:
                logger.warning("会话文件删除失败: %s: %s", canvas_id, e)

    def _messages_internal(self, canvas_id: str) -> list[dict]:
        """内部可变引用（先走一遍懒加载确保已初始化）"""
        self._ensure_loaded(canvas_id)
        return self._sessions[canvas_id]

    def _save(self, canvas_id: str) -> None:
        path = self._path(canvas_id)
        payload = {
            "canvas_id": canvas_id,
            "messages": self._sessions.get(canvas_id, []),
            "runs": self._runs.get(canvas_id, []),
        }
        tmp = path.with_suffix(".json.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as e:
            # 磁盘写入失败不影响内存中的会话
            logger.warning("对话历史落盘失败（仅保留内存版）: %s: %s", path.name, e)
            try:
                tmp.unlink(missing_ok=True)
            except OSError as cleanup_err:
                # 临时文件清理失败不影响主流程，但保留痕迹便于排查磁盘问题
                logger.debug("对话历史临时文件清理失败: %s: %s", tmp.name, cleanup_err)
