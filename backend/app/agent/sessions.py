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
            logger.debug(
                "[Session] 上下文注入 canvas=%s | 总历史=%d条 | 注入=%d条",
                canvas_id, total, len(msgs),
            )
            return msgs

    def append_user_message(self, canvas_id: str, user_message: str) -> None:
        """立即保存用户消息（发送时调用，确保切换画布后历史不丢失）"""
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            msgs.append({"role": "user", "content": user_message})
            # 超限丢弃最早的消息
            if len(msgs) > _MAX_MESSAGES:
                del msgs[: len(msgs) - _MAX_MESSAGES]
            logger.debug(
                "[Session] 保存用户消息 canvas=%s | 当前=%d条 | user=%s",
                canvas_id, len(msgs), user_message[:60].replace("\n", " "),
            )
            self._save(canvas_id)

    def append_assistant_message(self, canvas_id: str, assistant_message: str) -> None:
        """保存助手回复（worker 完成后调用）"""
        with self._lock:
            msgs = self._messages_internal(canvas_id)
            msgs.append({"role": "assistant", "content": assistant_message})
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
        """完成 run 记录，更新状态为 done/failed/stopped"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            for run in runs:
                if run.get("id") == run_id:
                    run["status"] = status
                    run["message"] = message
                    if error:
                        run["error"] = error
                    break
            self._save(canvas_id)
            logger.debug("[Session] 完成执行 canvas=%s run_id=%s status=%s", canvas_id, run_id, status)

    def last_run(self, canvas_id: str) -> dict | None:
        """最近一条执行记录（判断"重试/继续"指向哪个任务），无记录返回 None"""
        with self._lock:
            self._ensure_loaded(canvas_id)
            runs = self._runs.get(canvas_id) or []
            return copy.deepcopy(runs[-1]) if runs else None

    def clear(self, canvas_id: str) -> None:
        """清空对话历史与执行记录（内存 + 磁盘）"""
        with self._lock:
            self._sessions[canvas_id] = []
            self._runs[canvas_id] = []
            self._save(canvas_id)

    def delete(self, canvas_id: str) -> None:
        """画布被删除时级联清理会话"""
        with self._lock:
            self._sessions.pop(canvas_id, None)
            self._runs.pop(canvas_id, None)
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
            except OSError:
                pass
