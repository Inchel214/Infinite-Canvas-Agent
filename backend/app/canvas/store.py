"""画布状态存储（内存 + 文件持久化，预留数据库扩展点）"""
from __future__ import annotations

import copy
import json
import os
import time
from abc import ABC, abstractmethod
from pathlib import Path

from app.canvas.state import CanvasState, create_canvas
from app.image.files import (
    IMAGES_DIR,
    _rel_from_url,
    is_local_image_url,
    materialize_state_images,
    normalize_state_image_sizes,
)

# 历史栈最大长度（避免无限制增长占用内存）
_MAX_HISTORY = 50


class BaseStore(ABC):
    """存储抽象接口，后续可替换为 Postgres/Redis"""

    @abstractmethod
    def get_canvas(self, canvas_id: str) -> CanvasState:
        ...

    @abstractmethod
    def save_canvas(self, state: CanvasState) -> None:
        ...

    @abstractmethod
    def create_canvas(self, name: str = "") -> CanvasState:
        ...

    @abstractmethod
    def undo(self, canvas_id: str) -> CanvasState | None:
        """撤销最近一次 save_canvas，恢复到上一份快照。无历史可撤销时返回 None。"""
        ...

    @abstractmethod
    def redo(self, canvas_id: str) -> CanvasState | None:
        """重做最近一次 undo，恢复到撤销前的状态。无可重做时返回 None。"""
        ...

    @abstractmethod
    def list_canvases(self) -> list[dict]:
        """列出所有画布摘要：[{canvas_id, name, node_count, updated_at}]"""
        ...

    @abstractmethod
    def delete_canvas(self, canvas_id: str) -> None:
        """删除画布（内存 + 持久层）。不存在时抛 ValueError。"""
        ...


class InMemoryStore(BaseStore):
    """内存存储（带 undo 历史栈）"""

    def __init__(self):
        self._canvases: dict[str, CanvasState] = {}
        # 每个 canvas_id 对应一份快照栈，按时间顺序，最后入栈的是最近一次保存前的状态
        self._history: dict[str, list[CanvasState]] = {}
        # redo 栈：undo 时把当前状态压入，redo 时弹出
        self._redo: dict[str, list[CanvasState]] = {}

    def create_canvas(self, name: str = "") -> CanvasState:
        state = create_canvas(name)
        self._canvases[state.canvas_id] = state
        self._history[state.canvas_id] = []
        self._redo[state.canvas_id] = []
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        if canvas_id not in self._canvases:
            raise ValueError(f"画布不存在: {canvas_id}")
        # 返回深拷贝：调用方修改不影响内存中的"旧状态"，保证 undo 历史正确
        return copy.deepcopy(self._canvases[canvas_id])

    def save_canvas(self, state: CanvasState) -> None:
        cid = state.canvas_id
        state.updated_at = time.time()
        # 入栈：保存"当前内存中的旧状态"的深拷贝，作为可撤销点
        if cid in self._canvases:
            hist = self._history.setdefault(cid, [])
            hist.append(copy.deepcopy(self._canvases[cid]))
            if len(hist) > _MAX_HISTORY:
                hist.pop(0)
        # 新操作清空 redo 栈（undo 后再操作，redo 历史失效）
        self._redo[cid] = []
        self._canvases[cid] = state

    def undo(self, canvas_id: str) -> CanvasState | None:
        hist = self._history.get(canvas_id) or []
        if not hist:
            return None
        prev = hist.pop()
        # 把当前状态压入 redo 栈
        redo_stack = self._redo.setdefault(canvas_id, [])
        redo_stack.append(copy.deepcopy(self._canvases[canvas_id]))
        if len(redo_stack) > _MAX_HISTORY:
            redo_stack.pop(0)
        # 恢复到内存（不重新入栈，否则无法重做/反复撤销）
        self._canvases[canvas_id] = prev
        return prev

    def redo(self, canvas_id: str) -> CanvasState | None:
        redo_stack = self._redo.get(canvas_id) or []
        if not redo_stack:
            return None
        nxt = redo_stack.pop()
        # 把当前状态压回 undo 栈
        hist = self._history.setdefault(canvas_id, [])
        hist.append(copy.deepcopy(self._canvases[canvas_id]))
        if len(hist) > _MAX_HISTORY:
            hist.pop(0)
        self._canvases[canvas_id] = nxt
        return nxt

    def list_canvases(self) -> list[dict]:
        summaries = [
            {
                "canvas_id": cid,
                "name": s.name or f"画布 {cid[:6]}",
                "node_count": len(s.nodes),
                "updated_at": s.updated_at,
            }
            for cid, s in self._canvases.items()
        ]
        summaries.sort(key=lambda x: x["updated_at"], reverse=True)
        return summaries

    def delete_canvas(self, canvas_id: str) -> None:
        if canvas_id not in self._canvases:
            raise ValueError(f"画布不存在: {canvas_id}")
        del self._canvases[canvas_id]
        self._history.pop(canvas_id, None)
        self._redo.pop(canvas_id, None)


class FileStore(InMemoryStore):
    """内存 + 文件持久化存储，后端重启后仍可恢复画布状态"""

    def __init__(self, data_dir: str | None = None):
        super().__init__()
        if data_dir is None:
            data_dir = os.getenv("CANVAS_DATA_DIR")
        if data_dir is None:
            # 默认放在 backend/data/canvases
            data_dir = str(Path(__file__).resolve().parent.parent.parent / "data" / "canvases")
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        # image_url -> 画布显示尺寸：避免每次 GET 都重复解析图片文件
        self._image_size_cache: dict[str, tuple[int, int]] = {}

    def _canvas_path(self, canvas_id: str) -> Path:
        # 用 canvas_id 作为文件名（uuid，安全）
        return self._data_dir / f"{canvas_id}.json"

    def _load_from_disk(self, canvas_id: str) -> CanvasState | None:
        path = self._canvas_path(canvas_id)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            return CanvasState.from_dict(data)
        except (json.JSONDecodeError, KeyError, OSError):
            return None

    def create_canvas(self, name: str = "") -> CanvasState:
        # 不走 save_canvas（避免创建动作本身被入栈为可撤销点）
        state = create_canvas(name)
        self._canvases[state.canvas_id] = state
        self._history[state.canvas_id] = []
        self._redo[state.canvas_id] = []
        # 写入磁盘
        path = self._canvas_path(state.canvas_id)
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(state.to_dict(), f, ensure_ascii=False)
        except OSError:
            pass
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        # 优先内存，其次磁盘（懒加载，支持后端重启后恢复）
        if canvas_id in self._canvases:
            state = self._canvases[canvas_id]
            if normalize_state_image_sizes(state, self._image_size_cache):
                state.version += 1
                self._write_canvas(state)
            # 返回深拷贝：调用方修改不影响内存中的"旧状态"，保证 undo 历史正确
            return copy.deepcopy(state)
        state = self._load_from_disk(canvas_id)
        if state is None:
            raise ValueError(f"画布不存在: {canvas_id}")
        if normalize_state_image_sizes(state, self._image_size_cache):
            state.version += 1
            self._write_canvas(state)
        self._canvases[canvas_id] = state
        return copy.deepcopy(state)

    def _write_canvas(self, state: CanvasState) -> None:
        """写回画布快照；用于正常保存与无撤销点的数据迁移。

        原子写：先写 .tmp 再 os.replace 替换。直接覆写主文件时，
        并发的列表轮询（list_canvases glob 读同一文件）会读到写了一半的
        JSON 而把该画布从列表里静默剔除——表现为"画布管理里有时不显示画布"。
        """
        path = self._canvas_path(state.canvas_id)
        tmp = path.with_suffix(".json.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(state.to_dict(), f, ensure_ascii=False)
        except OSError:
            return
        # Windows 下目标文件被并发读者瞬间占用会 PermissionError，短暂重试
        for _ in range(6):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.02)
        # 放弃本次落盘（内存仍是新版本，下次保存再写）；清理残留临时文件
        try:
            tmp.unlink()
        except OSError:
            pass

    def save_canvas(self, state: CanvasState) -> None:
        # base64 节点图片落盘为文件，画布 JSON 只存 http URL（KB 级）
        materialize_state_images(state)
        # 生成服务未返回可靠尺寸时，以最终图片真实比例为准
        normalize_state_image_sizes(state, self._image_size_cache)
        super().save_canvas(state)
        # 写入磁盘，确保刷新/重启后可恢复
        self._write_canvas(state)

    def undo(self, canvas_id: str) -> CanvasState | None:
        prev = super().undo(canvas_id)
        if prev is not None:
            # 历史快照可能含旧 base64，落盘前同样物化为文件
            materialize_state_images(prev)
            normalize_state_image_sizes(prev, self._image_size_cache)
            # 同步写回磁盘，保持内存/磁盘一致
            self._write_canvas(prev)
        return prev

    def redo(self, canvas_id: str) -> CanvasState | None:
        nxt = super().redo(canvas_id)
        if nxt is not None:
            materialize_state_images(nxt)
            normalize_state_image_sizes(nxt, self._image_size_cache)
            self._write_canvas(nxt)
        return nxt

    def list_canvases(self) -> list[dict]:
        """内存 + 磁盘合并列出所有画布摘要（磁盘文件为全集，内存数据更新）"""
        seen: dict[str, dict] = {}
        # 磁盘全集（重启后内存只含已访问过的画布，以磁盘为准）
        for path in self._data_dir.glob("*.json"):
            cid = path.stem
            try:
                with path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                state = self._canvases.get(cid)
                if state is not None:
                    # 内存中的版本更新（含未落盘的 updated_at）
                    seen[cid] = {
                        "canvas_id": cid,
                        "name": state.name or f"画布 {cid[:6]}",
                        "node_count": len(state.nodes),
                        "updated_at": state.updated_at,
                    }
                else:
                    seen[cid] = {
                        "canvas_id": cid,
                        "name": data.get("name") or f"画布 {cid[:6]}",
                        "node_count": len(data.get("nodes", {})),
                        "updated_at": data.get("updated_at", 0),
                    }
            except (json.JSONDecodeError, OSError):
                # 读失败/半截文件：回退内存版本（若有），绝不静默缺项——
                # 列表里少一个画布比显示旧数据更让用户困惑
                state = self._canvases.get(cid)
                if state is not None:
                    seen[cid] = {
                        "canvas_id": cid,
                        "name": state.name or f"画布 {cid[:6]}",
                        "node_count": len(state.nodes),
                        "updated_at": state.updated_at,
                    }
                continue
        # 内存中存在但磁盘没有的（理论上不会出现，防御性保留）
        for cid, state in self._canvases.items():
            if cid not in seen:
                seen[cid] = {
                    "canvas_id": cid,
                    "name": state.name or f"画布 {cid[:6]}",
                    "node_count": len(state.nodes),
                    "updated_at": state.updated_at,
                }
        summaries = list(seen.values())
        summaries.sort(key=lambda x: x["updated_at"], reverse=True)
        return summaries

    def delete_canvas(self, canvas_id: str) -> None:
        path = self._canvas_path(canvas_id)
        exists = path.exists()
        if not exists and canvas_id not in self._canvases:
            raise ValueError(f"画布不存在: {canvas_id}")
        # 删除前收集该画布引用的本地图片（旧平铺格式），用于级联清理
        state = self._canvases.get(canvas_id) or self._load_from_disk(canvas_id)
        referenced = [
            n.image_url for n in (state.nodes.values() if state else [])
            if n.image_url and is_local_image_url(n.image_url)
        ]
        # 清内存与撤销/重做历史
        self._canvases.pop(canvas_id, None)
        self._history.pop(canvas_id, None)
        self._redo.pop(canvas_id, None)
        # 删磁盘文件
        if exists:
            try:
                path.unlink()
            except OSError:
                pass
        # 级联删除图片：整删画布子目录（新归类格式），再删旧平铺格式的引用文件
        self._delete_canvas_images(canvas_id, referenced)

    def _delete_canvas_images(self, canvas_id: str, referenced_urls: list[str]) -> None:
        """画布删除后清理其图片文件；失败不阻断删除流程"""
        import shutil

        # 新格式：images/{canvas_id}/ 整目录
        canvas_dir = IMAGES_DIR / canvas_id
        if canvas_dir.is_dir():
            try:
                shutil.rmtree(canvas_dir)
            except OSError:
                pass
        # 旧格式：平铺在根目录的引用文件（别的画布未引用才安全删——
        # 平铺时代图片不区分归属，仅当文件不在任何其他画布 JSON 中时删除）
        if not referenced_urls:
            return
        other_refs: set[str] = set()
        for p in self._data_dir.glob("*.json"):
            if p.stem == canvas_id:
                continue
            try:
                with p.open("r", encoding="utf-8") as f:
                    d = json.load(f)
                for n in d.get("nodes", {}).values():
                    u = n.get("image_url") or ""
                    if u and is_local_image_url(u):
                        try:
                            other_refs.add(_rel_from_url(u))
                        except ValueError:
                            pass
            except (json.JSONDecodeError, OSError):
                continue
        for url in referenced_urls:
            try:
                rel = _rel_from_url(url)
            except ValueError:
                continue
            if rel in other_refs:
                continue  # 仍被其他画布引用，保留
            try:
                (IMAGES_DIR / rel).unlink()
            except OSError:
                pass
