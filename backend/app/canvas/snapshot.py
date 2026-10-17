"""画布快照管理：保存/恢复/列出/删除快照"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from app.canvas.state import CanvasState

# 快照存储目录
SNAPSHOT_DIR = Path(__file__).parent.parent.parent / "data" / "snapshots"


def _ensure_dir():
    """确保快照目录存在"""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _snapshot_path(canvas_id: str, snapshot_id: str) -> Path:
    """快照文件路径"""
    return SNAPSHOT_DIR / canvas_id / f"{snapshot_id}.json"


def save_snapshot(canvas: CanvasState, name: str = "") -> dict:
    """
    保存画布快照
    返回 {snapshot_id, name, created_at}
    """
    _ensure_dir()
    canvas_dir = SNAPSHOT_DIR / canvas.canvas_id
    canvas_dir.mkdir(parents=True, exist_ok=True)

    snapshot_id = str(int(time.time() * 1000))
    snapshot_data = {
        "snapshot_id": snapshot_id,
        "canvas_id": canvas.canvas_id,
        "name": name or f"快照 {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "created_at": time.time(),
        "canvas": canvas.to_dict(),
    }

    path = _snapshot_path(canvas.canvas_id, snapshot_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snapshot_data, f, ensure_ascii=False, indent=2)

    return {
        "snapshot_id": snapshot_id,
        "name": snapshot_data["name"],
        "created_at": snapshot_data["created_at"],
    }


def list_snapshots(canvas_id: str) -> list[dict]:
    """
    列出画布的所有快照（按创建时间倒序）
    返回 [{snapshot_id, name, created_at}, ...]
    """
    _ensure_dir()
    canvas_dir = SNAPSHOT_DIR / canvas_id
    if not canvas_dir.exists():
        return []

    snapshots = []
    for path in canvas_dir.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                snapshots.append({
                    "snapshot_id": data["snapshot_id"],
                    "name": data["name"],
                    "created_at": data["created_at"],
                })
        except Exception:
            continue

    # 按创建时间倒序
    snapshots.sort(key=lambda s: s["created_at"], reverse=True)
    return snapshots


def load_snapshot(canvas_id: str, snapshot_id: str) -> dict | None:
    """
    加载快照数据
    返回快照完整数据（含 canvas），不存在返回 None
    """
    path = _snapshot_path(canvas_id, snapshot_id)
    if not path.exists():
        return None

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def delete_snapshot(canvas_id: str, snapshot_id: str) -> bool:
    """
    删除快照
    返回是否成功删除
    """
    path = _snapshot_path(canvas_id, snapshot_id)
    if not path.exists():
        return False

    path.unlink()
    return True


def restore_from_snapshot(snapshot_data: dict) -> CanvasState:
    """
    从快照数据恢复画布状态
    返回新的 CanvasState
    """
    return CanvasState.from_dict(snapshot_data["canvas"])
