"""REST API 路由"""
from __future__ import annotations

import json
import logging
import queue
import subprocess
import sys
import threading
import uuid
from typing import List, Optional

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import deps
from app import experiences
from app.canvas.state import CanvasNode, CanvasState
from app.providers.schema import (
    AppSettings,
    ImageConfig,
    LLMConfig,
    PROVIDER_PRESETS,
    mask_key,
    resolve_preset,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["agent"])

# per-canvas 写锁：同步 def 端点跑在线程池，多容器并发生成完成时的
# "读最新→加节点→保存"若不加锁仍是读-改-写竞态（后完成的覆盖先完成的，静默丢图）
_canvas_write_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _canvas_lock(canvas_id: str) -> threading.Lock:
    with _locks_guard:
        lk = _canvas_write_locks.get(canvas_id)
        if lk is None:
            lk = threading.Lock()
            _canvas_write_locks[canvas_id] = lk
        return lk


class ChatRequest(BaseModel):
    canvas_id: str
    prompt: str


class ChatResponse(BaseModel):
    success: bool
    message: str
    canvas: dict
    steps: List[dict]


class UpdateNodeRequest(BaseModel):
    x: float
    y: float


class ComposeRequest(BaseModel):
    node_ids: List[str]
    prompt: str = ""
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_ids: Optional[List[str]] = None  # 风格库（多选）：选中后读全文拼接进 prompt
    experience_id: Optional[str] = None  # 兼容旧字段（单选）


class VariateRequest(BaseModel):
    node_id: str
    prompt: str = ""
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_ids: Optional[List[str]] = None
    experience_id: Optional[str] = None


class EditRequest(BaseModel):
    node_id: str
    prompt: str
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_ids: Optional[List[str]] = None
    experience_id: Optional[str] = None


class GenerateRequest(BaseModel):
    prompt: str
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_ids: Optional[List[str]] = None
    experience_id: Optional[str] = None


class StreamGenRequest(BaseModel):
    op: str  # "generate" | "variate" | "compose"
    prompt: str = ""
    size: str = "2K"
    x: float = 100
    y: float = 100
    node_id: Optional[str] = None
    node_ids: Optional[List[str]] = None
    experience_ids: Optional[List[str]] = None
    experience_id: Optional[str] = None


class ExperienceIn(BaseModel):
    """导入风格 MD：名称/描述/正文"""
    name: str
    description: str = ""
    content: str


class ExperienceUpdate(BaseModel):
    """编辑风格元数据（名称/描述）"""
    name: Optional[str] = None
    description: Optional[str] = None


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _apply_styles(req, prompt: str) -> str:
    """风格库拼接：合并多选 experience_ids 与兼容旧单选 experience_id，逐份全文拼接"""
    ids = list(req.experience_ids or [])
    if req.experience_id and req.experience_id not in ids:
        ids.append(req.experience_id)
    return experiences.apply_experiences(ids, prompt) if ids else prompt


def _resolve_node_ref(state: CanvasState, ref: str) -> CanvasNode | None:
    """节点引用解析：支持节点 ID 与 '#N' 编号两种写法。

    MCP/Codex 与用户对话统一用 '#N' 指代节点；解析失败返回 None（调用方跳过或告警）。
    """
    ref = (ref or "").strip()
    if not ref:
        return None
    if ref.startswith("#"):
        try:
            idx = int(ref[1:])
        except ValueError:
            return None
        for n in state.nodes.values():
            if n.index == idx:
                return n
        return None
    return state.get_node(ref)


class CanvasCreateIn(BaseModel):
    """创建画布：可自定义名称，留空则自动编号"""
    name: str = ""


@router.post("/canvas", summary="创建新画布")
def create_canvas(body: Optional[CanvasCreateIn] = None):
    # 默认名按现有数量递增，避免都叫"未命名"
    custom = (body.name or "").strip() if body else ""
    default_name = custom if custom else f"画布 {len(deps.store.list_canvases()) + 1}"
    state = deps.store.create_canvas(default_name)
    return {"canvas_id": state.canvas_id, "name": state.name}


@router.get("/canvas", summary="列出所有画布摘要")
def list_canvases():
    # 合并生图任务状态：前端据此显示画布红点（生成中 / 未查看新图）
    from app.tools import tasks as task_registry

    return [
        {**c, **task_registry.summary(c["canvas_id"])} for c in deps.store.list_canvases()
    ]


@router.get("/canvas/{canvas_id}", summary="获取画布状态（summary=1 时返回 LLM 精简视图）")
def get_canvas(canvas_id: str, summary: int = 0):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if summary:
        # LLM 精简视图（MCP/Codex 用）：编号 + 截断内容 + 连线引用，避免大 JSON 撑爆上下文
        by_id = state.nodes
        return {
            "canvas_id": state.canvas_id,
            "name": state.name,
            "version": state.version,
            "node_count": len(state.nodes),
            "nodes": [
                {
                    "id": n.id,
                    "index": n.index,
                    "type": n.type,
                    "x": n.x,
                    "y": n.y,
                    "width": n.width,
                    "height": n.height,
                    "content": (n.content or "")[:100],
                    "image": bool(n.image_url),
                    # 连线来源转为 "#N" 编号，与 add/update 的引用写法对齐
                    "sources": [
                        f"#{by_id[s].index}" if s in by_id else s for s in n.source_ids
                    ],
                }
                for n in sorted(state.nodes.values(), key=lambda v: v.index or 0)
            ],
        }
    return state.to_dict()


class RenameCanvasRequest(BaseModel):
    name: str


@router.patch("/canvas/{canvas_id}", summary="重命名画布")
def rename_canvas(canvas_id: str, req: RenameCanvasRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="画布名称不能为空")
    if len(name) > 50:
        raise HTTPException(status_code=400, detail="画布名称不能超过 50 字")
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    state.name = name
    deps.store.save_canvas(state)
    return {"success": True, "message": "已重命名", "name": name}


@router.delete("/canvas/{canvas_id}", summary="删除画布")
def delete_canvas(canvas_id: str):
    try:
        deps.store.delete_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    # 清理该画布的生图任务跟踪（红点状态）
    from app.tools import tasks as task_registry

    task_registry.drop(canvas_id)
    # 级联清理该画布的 Agent 对话历史
    deps.chat_sessions.delete(canvas_id)
    return {"success": True, "message": "已删除画布"}


@router.patch("/canvas/{canvas_id}/node/{node_id}", summary="更新节点位置")
def update_node(canvas_id: str, node_id: str, req: UpdateNodeRequest):
    with _canvas_lock(canvas_id):
        try:
            state = deps.store.get_canvas(canvas_id)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        state.update_node_position(node_id, req.x, req.y)
        deps.store.save_canvas(state)
    return state.to_dict()


@router.post("/canvas/{canvas_id}/compose", summary="多图组合（直接执行，不走 Agent）")
def compose_images(canvas_id: str, req: ComposeRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    tool = deps.tool_manager.get("compose_images")
    prompt = _apply_styles(req, req.prompt)
    kwargs = {"node_ids": req.node_ids, "prompt": prompt, "size": req.size}
    if req.x is not None:
        kwargs["x"] = req.x
    if req.y is not None:
        kwargs["y"] = req.y
    result = tool.run(state, **kwargs)
    if result.state:
        deps.store.save_canvas(result.state)
    return {
        "success": result.success,
        "message": result.message,
        "canvas": result.state.to_dict(),
    }


@router.post("/canvas/{canvas_id}/variate", summary="图生图变体（直接执行，不走 Agent）")
def variate_image(canvas_id: str, req: VariateRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    prompt = req.prompt or "基于参考图生成一个高质量的新变体，保持风格一致"
    prompt = _apply_styles(req, prompt)
    tool = deps.tool_manager.get("variate_image")
    kwargs = {"node_id": req.node_id, "prompt": prompt, "size": req.size}
    if req.x is not None:
        kwargs["x"] = req.x
    if req.y is not None:
        kwargs["y"] = req.y
    result = tool.run(state, **kwargs)
    if result.state:
        deps.store.save_canvas(result.state)
    return {
        "success": result.success,
        "message": result.message,
        "canvas": result.state.to_dict(),
    }


@router.post("/canvas/{canvas_id}/edit", summary="局部编辑图片（直接执行，不走 Agent）")
def edit_image(canvas_id: str, req: EditRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    tool = deps.tool_manager.get("edit_image")
    prompt = _apply_styles(req, req.prompt)
    kwargs = {"node_id": req.node_id, "prompt": prompt, "size": req.size}
    if req.x is not None:
        kwargs["x"] = req.x
    if req.y is not None:
        kwargs["y"] = req.y
    result = tool.run(state, **kwargs)
    if result.state:
        deps.store.save_canvas(result.state)
    return {
        "success": result.success,
        "message": result.message,
        "canvas": result.state.to_dict(),
    }


@router.delete("/canvas/{canvas_id}/node/{node_id}", summary="删除节点")
def delete_node(canvas_id: str, node_id: str):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    tool = deps.tool_manager.get("delete_node")
    result = tool.run(state, node_id=node_id)
    if result.state:
        deps.store.save_canvas(result.state)
    return {
        "success": result.success,
        "message": result.message,
        "canvas": result.state.to_dict(),
    }


class BatchDeleteRequest(BaseModel):
    node_ids: List[str]


class BatchMoveItem(BaseModel):
    node_id: str
    x: float
    y: float


class BatchMoveRequest(BaseModel):
    moves: List[BatchMoveItem]


@router.post("/canvas/{canvas_id}/nodes/move", summary="批量移动节点（多选整组拖拽，单次撤销）")
def batch_move_nodes(canvas_id: str, req: BatchMoveRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    moved = 0
    for m in req.moves:
        if state.get_node(m.node_id):
            state.update_node_position(m.node_id, m.x, m.y)
            moved += 1
    if moved > 0:
        deps.store.save_canvas(state)  # 单次保存 = 单次撤销点
    return {
        "success": True,
        "message": f"已移动 {moved} 张图片",
        "canvas": state.to_dict(),
    }


@router.post("/canvas/{canvas_id}/nodes/delete", summary="批量删除节点（单次撤销）")
def batch_delete_nodes(canvas_id: str, req: BatchDeleteRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    deleted = 0
    for nid in req.node_ids:
        node = _resolve_node_ref(state, nid)
        if node:
            state.remove_node(node.id)
            deleted += 1
    if deleted > 0:
        deps.store.save_canvas(state)
    return {
        "success": True,
        "message": f"已删除 {deleted} 张图片",
        "canvas": state.to_dict(),
    }


class TextNodeIn(BaseModel):
    """单个文本卡片：content 必填；x/y 缺省时自动寻找空白位置；parent_ids 建立连线"""
    content: str
    x: Optional[float] = None
    y: Optional[float] = None
    width: float = 280
    height: float = 160
    parent_ids: Optional[List[str]] = None  # 节点 ID 或 "#N" 编号


class TextNodesRequest(BaseModel):
    nodes: List[TextNodeIn]


@router.post(
    "/canvas/{canvas_id}/nodes/text",
    summary="批量添加文本节点（MCP 初稿主干；单次保存=单次撤销）",
)
def add_text_nodes(canvas_id: str, req: TextNodesRequest):
    from app.tools.layout import next_position

    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not req.nodes:
        raise HTTPException(status_code=400, detail="nodes 不能为空")

    created: list[dict] = []
    skipped_parents: list[str] = []
    for item in req.nodes:
        content = item.content.strip()
        if not content:
            continue
        width = max(120.0, item.width)
        height = max(60.0, item.height)
        x, y = item.x, item.y
        if x is None or y is None:
            x, y = next_position(state, width, height)
        parents: list[str] = []
        for ref in item.parent_ids or []:
            p = _resolve_node_ref(state, ref)
            if p is not None:
                parents.append(p.id)
            else:
                skipped_parents.append(ref)
        node = CanvasNode(
            id=str(uuid.uuid4()),
            type="text",
            x=float(x),
            y=float(y),
            width=width,
            height=height,
            content=content,
            source_ids=parents,
        )
        state.add_node(node)
        created.append(
            {"node_id": node.id, "index": node.index, "x": node.x, "y": node.y}
        )

    if not created:
        raise HTTPException(status_code=400, detail="没有有效的文本内容")
    deps.store.save_canvas(state)
    result = {
        "success": True,
        "message": f"已添加 {len(created)} 个文本节点",
        "created": created,
        "canvas_version": state.version,
    }
    if skipped_parents:
        result["warning"] = f"未找到的连线引用（已忽略）: {', '.join(skipped_parents)}"
    return result


class NodeUpdateIn(BaseModel):
    """节点更新：node_id 支持节点 ID 或 "#N"；只更新给出的字段"""
    node_id: str
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    content: Optional[str] = None
    source_ids: Optional[List[str]] = None  # 节点 ID 或 "#N" 列表（整体覆盖连线）
    group: Optional[str] = None  # 分组标签（用于分区布局）


class NodesUpdateRequest(BaseModel):
    updates: List[NodeUpdateIn]


@router.post(
    "/canvas/{canvas_id}/nodes/update",
    summary="批量更新节点（位置/尺寸/内容/连线；单次撤销）",
)
def batch_update_nodes(canvas_id: str, req: NodesUpdateRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not req.updates:
        raise HTTPException(status_code=400, detail="updates 不能为空")

    updated: list[str] = []
    missing: list[str] = []
    for u in req.updates:
        node = _resolve_node_ref(state, u.node_id)
        if node is None:
            missing.append(u.node_id)
            continue
        if u.x is not None:
            node.x = float(u.x)
        if u.y is not None:
            node.y = float(u.y)
        if u.width is not None:
            node.width = max(40.0, float(u.width))
        if u.height is not None:
            node.height = max(40.0, float(u.height))
        if u.content is not None:
            node.content = u.content
        if u.source_ids is not None:
            resolved: list[str] = []
            for ref in u.source_ids:
                p = _resolve_node_ref(state, ref)
                if p is not None and p.id != node.id:
                    resolved.append(p.id)
            node.source_ids = resolved
        if u.group is not None:
            node.group = u.group
        updated.append(f"#{node.index}" if node.index is not None else node.id)

    if updated:
        state.version += 1
        deps.store.save_canvas(state)
    result = {
        "success": True,
        "message": f"已更新 {len(updated)} 个节点",
        "updated": updated,
        "canvas_version": state.version,
    }
    if missing:
        result["warning"] = f"未找到的节点（已跳过）: {', '.join(missing)}"
    return result


@router.post("/canvas/{canvas_id}/undo", summary="撤销最近一次操作")
def undo_canvas(canvas_id: str):
    try:
        prev = deps.store.undo(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if prev is None:
        # 无历史可撤销：返回当前状态，前端可据此提示
        current = deps.store.get_canvas(canvas_id)
        return {"success": False, "message": "无可撤销操作", "canvas": current.to_dict()}
    return {"success": True, "message": "已撤销", "canvas": prev.to_dict()}


@router.post("/canvas/{canvas_id}/redo", summary="重做最近一次撤销")
def redo_canvas(canvas_id: str):
    try:
        nxt = deps.store.redo(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if nxt is None:
        current = deps.store.get_canvas(canvas_id)
        return {"success": False, "message": "无可重做操作", "canvas": current.to_dict()}
    return {"success": True, "message": "已重做", "canvas": nxt.to_dict()}


@router.post("/canvas/{canvas_id}/seen", summary="清除画布未读（切换到该画布时调用）")
def mark_canvas_seen(canvas_id: str):
    from app.tools import tasks as task_registry

    task_registry.seen(canvas_id)
    return {"success": True}


@router.post("/canvas/{canvas_id}/arrange", summary="自动整理画布（网格对齐所有图片）")
def arrange_canvas(canvas_id: str):
    from app.tools.layout import arrange_canvas as do_arrange

    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    positions = do_arrange(state)
    if not positions:
        return {"success": True, "message": "画布为空，无需整理", "canvas": state.to_dict()}
    for nid, (x, y) in positions.items():
        node = state.get_node(nid)
        if node:
            node.x = x
            node.y = y
    state.version += 1
    deps.store.save_canvas(state)  # save 会推入 undo 栈，整理可撤销
    return {"success": True, "message": f"已整理 {len(positions)} 个节点", "canvas": state.to_dict()}


@router.post("/canvas/{canvas_id}/generate", summary="文生图（直接执行，不走 Agent）")
def generate_image(canvas_id: str, req: GenerateRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    tool = deps.tool_manager.get("generate_image")
    prompt = _apply_styles(req, req.prompt)
    kwargs = {"prompt": prompt, "size": req.size}
    if req.x is not None:
        kwargs["x"] = req.x
    if req.y is not None:
        kwargs["y"] = req.y
    result = tool.run(state, **kwargs)
    if not result.success or result.state is None:
        return {
            "success": False,
            "message": result.message,
            "canvas": (result.state or state).to_dict(),
        }
    # 并发安全提交：生成耗时期间其他请求可能已写入画布（如 MCP 批量并发生图），
    # 锁内重读最新状态增量添加，避免整体覆盖丢图（与 /generate_stream 的 _add_node 同模式）
    node_id = (result.data or {}).get("node_id")
    node = result.state.nodes.get(node_id) if node_id else None
    if node is None:
        return {
            "success": False,
            "message": "生成失败：未返回节点",
            "canvas": result.state.to_dict(),
        }
    with _canvas_lock(canvas_id):
        latest = deps.store.get_canvas(canvas_id)
        node.index = None  # 旧快照上的编号可能与并发写入撞号，按最新画布重新分配
        latest.add_node(node)
        deps.store.save_canvas(latest)
    return {
        "success": True,
        "message": result.message,
        "canvas": latest.to_dict(),
    }


class UploadImageRequest(BaseModel):
    image_url: str  # data URL（前端 FileReader 读取）
    x: float = 100
    y: float = 100
    width: int = 300
    height: int = 300
    content: str = ""


@router.post("/canvas/{canvas_id}/upload_image", summary="上传本地图片为画布节点")
def upload_image(canvas_id: str, req: UploadImageRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not req.image_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="仅支持 data URL 格式图片")
    node = CanvasNode(
        id=str(uuid.uuid4()),
        type="image",
        x=req.x,
        y=req.y,
        width=req.width,
        height=req.height,
        content=req.content or "本地图片",
        image_url=req.image_url,
        source_ids=[],
    )
    state.add_node(node)
    deps.store.save_canvas(state)
    return {
        "success": True,
        "message": "已添加图片",
        "canvas": state.to_dict(),
    }


class CloneNodeRequest(BaseModel):
    image_url: str
    x: float = 100
    y: float = 100
    width: int = 300
    height: int = 300
    content: str = ""
    source_ids: list = []


@router.post("/canvas/{canvas_id}/nodes/clone", summary="克隆节点（复制完整属性，含提示词）")
def clone_node(canvas_id: str, req: CloneNodeRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    node = CanvasNode(
        id=str(uuid.uuid4()),
        type="image",
        x=req.x,
        y=req.y,
        width=req.width,
        height=req.height,
        content=req.content,
        image_url=req.image_url,
        source_ids=list(req.source_ids),
    )
    state.add_node(node)
    deps.store.save_canvas(state)
    return {
        "success": True,
        "message": "已复制节点",
        "canvas": state.to_dict(),
    }


@router.post("/canvas/{canvas_id}/generate_stream", summary="图片容器流式生成（SSE）")
def generate_image_stream(canvas_id: str, req: StreamGenRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # 解析参考图和提示词（与工具逻辑一致）
    if req.op == "compose":
        ids = req.node_ids or []
        sources = [state.get_node(nid) for nid in ids]
        sources = [n for n in sources if n is not None and n.image_url]
        if len(sources) < 2:
            raise HTTPException(status_code=400, detail="至少需要 2 张图片才能组合")
        ref_urls = [n.image_url for n in sources]
        prompt = req.prompt or "融合以上图片的内容，生成一张新图"
        width = max(n.width for n in sources)
        height = max(n.height for n in sources)
    elif req.op == "variate":
        node = state.get_node(req.node_id) if req.node_id else None
        if node is None or not node.image_url:
            raise HTTPException(status_code=400, detail="参考图不存在")
        ref_urls = [node.image_url]
        prompt = req.prompt or "基于参考图生成一个高质量的新变体，保持风格一致"
        width, height = node.width, node.height
        ids = [req.node_id]
    else:
        if not req.prompt.strip():
            raise HTTPException(status_code=400, detail="文生图需要描述")
        ref_urls = []
        prompt = req.prompt
        width, height = 300, 300
        ids = []

    size = req.size

    # 风格库：选中风格后读全文确定性拼接进 prompt（对三种 op 统一生效）
    prompt = _apply_styles(req, prompt)

    def _add_node(image_url: str, w: int, h: int) -> tuple[CanvasState, str]:
        """并发安全提交：锁内重读最新画布增量添加——多个容器并发生成时互不覆盖丢图。

        不能直接保存请求开头的旧快照：旧快照不含其它并发请求已写入的节点，整体覆盖会丢图；
        "读最新→加节点→保存"必须整体持锁，否则线程间仍是读-改-写竞态。"""
        with _canvas_lock(canvas_id):
            latest = deps.store.get_canvas(canvas_id)
            node = CanvasNode(
                id=str(uuid.uuid4()),
                type="image",
                x=req.x,
                y=req.y,
                width=w,
                height=h,
                content=prompt or "生成的图片",
                image_url=image_url,
                source_ids=ids,
            )
            latest.add_node(node)
            deps.store.save_canvas(latest)
        return latest, node.id

    gen = deps.manager.generator

    def sse():
        # 流式路径的任务跟踪：仅跟踪直连 generator 的流式分支；
        # 估算模式走工具装饰器 tracks_generation 自跟踪，这里不能重复 begin
        from app.tools import tasks as task_registry

        # 跟踪哨兵：正常完成/失败/回退时已 end；finally 兜底客户端断开（GeneratorExit）泄漏
        tracking = {"on": False}

        def _end_tracked(success: bool) -> None:
            if tracking["on"]:
                tracking["on"] = False
                task_registry.end(canvas_id, success=success)

        try:
            # 流式模式：支持 SSE 的真实 generator 逐预览推送
            if hasattr(gen, "generate_stream"):
                task_registry.begin(canvas_id)
                tracking["on"] = True
                yield _sse({"type": "start", "mode": "stream"})
                try:
                    for evt in gen.generate_stream(
                        prompt, image_urls=ref_urls, width=width, height=height, size=size
                    ):
                        if evt["type"] == "preview":
                            yield _sse(evt)
                        else:
                            result = evt["result"]
                            latest, node_id = _add_node(result.image_url, result.width, result.height)
                            _end_tracked(True)
                            yield _sse(
                                {
                                    "type": "done",
                                    "success": True,
                                    "message": "生成完成",
                                    "canvas": latest.to_dict(),
                                    "node_id": node_id,
                                }
                            )
                            return
                except ValueError:
                    # 流式不可用（模型不支持等）→ 平衡计数后回退非流式（工具装饰器重新跟踪）
                    logger.info("流式生成不可用，回退估算模式", exc_info=True)
                    _end_tracked(False)
                except Exception as e:
                    logger.exception("流式图片生成失败")
                    _end_tracked(False)
                    yield _sse({"type": "done", "success": False, "message": f"生成失败：{e}"})
                    return

            # 估算模式：无流式能力（Mock / 回退），前端用估算进度条
            yield _sse({"type": "start", "mode": "estimated"})
            if req.op == "compose":
                tool = deps.tool_manager.get("compose_images")
                result = tool.run(
                    state, node_ids=req.node_ids or [], prompt=prompt, size=size, x=req.x, y=req.y
                )
            elif req.op == "variate":
                tool = deps.tool_manager.get("variate_image")
                result = tool.run(
                    state, node_id=req.node_id or "", prompt=prompt, size=size, x=req.x, y=req.y
                )
            else:
                tool = deps.tool_manager.get("generate_image")
                result = tool.run(state, prompt=prompt, size=size, x=req.x, y=req.y)
            final_state = result.state
            generated_node_id = None
            if result.success:
                # 并发安全：锁内只把本次新增节点合并进最新画布（旧快照整体覆盖会丢并发结果）
                # 工具会原地修改 state，因此不能在工具执行后再靠新旧 ID 集合做差；
                # 直接使用本次工具返回的 node_id，和非流式 /generate 路径保持一致。
                generated_node_id = (result.data or {}).get("node_id")
                generated_node = (
                    result.state.nodes.get(generated_node_id)
                    if result.state is not None and generated_node_id
                    else None
                )
                if generated_node is None:
                    yield _sse(
                        {
                            "type": "done",
                            "success": False,
                            "message": "生成失败：未返回节点",
                            "canvas": state.to_dict(),
                            "node_id": None,
                        }
                    )
                    return
                with _canvas_lock(canvas_id):
                    latest = deps.store.get_canvas(canvas_id)
                    # 生成期间可能有其它并发请求先写入；按最新画布重新分配编号，避免撞号。
                    generated_node.index = None
                    latest.add_node(generated_node)
                    deps.store.save_canvas(latest)
                    final_state = latest
            yield _sse(
                {
                    "type": "done",
                    "success": result.success,
                    "message": result.message,
                    "canvas": final_state.to_dict(),
                    "node_id": generated_node_id,
                }
            )
        finally:
            _end_tracked(False)

    return StreamingResponse(sse(), media_type="text/event-stream")


@router.post("/agent/chat", response_model=ChatResponse, summary="发送提示词给 Agent（携带对话历史）")
def chat(req: ChatRequest):
    try:
        # 注入该画布的历史对话尾部，Agent 具备跨轮记忆
        history = deps.chat_sessions.get_context(req.canvas_id)
        result = deps.agent.run(req.prompt, req.canvas_id, history=history)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # 回写一轮对话（用户原文 + Agent 最终回复），供下轮上下文与前端历史展示
    deps.chat_sessions.append_round(req.canvas_id, req.prompt, result.message)

    return ChatResponse(
        success=result.success,
        message=result.message,
        canvas=result.state.to_dict(),
        steps=result.steps,
    )


class StopRequest(BaseModel):
    canvas_id: str


@router.post(
    "/agent/chat/stream",
    summary="Agent 对话（SSE 流式：计划/思考/工具过程/最终结果，支持停止）",
)
def chat_stream(req: ChatRequest):
    """SSE 事件协议：

    - start                  流开始
    - plan      {content}    执行计划（规划阶段产出，立即展示）
    - thought   {content}    模型边想边调工具时的自述
    - tool_start  {tool, args}           工具开始执行
    - tool_result {tool, result, success, canvas?} 工具执行完成（canvas 随事件增量刷新）
    - response {content}     最终文本回复
    - done      {success, stopped, message, canvas, steps} 终止事件
    """
    # 预校验画布存在：错误走标准 404，而不是流内 done 事件
    try:
        deps.store.get_canvas(req.canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    history = deps.chat_sessions.get_context(req.canvas_id)
    q: "queue.Queue[dict | None]" = queue.Queue()

    def worker():
        try:
            result = deps.agent.run(
                req.prompt, req.canvas_id, history=history,
                on_event=lambda e: q.put(e),
            )
            # 与 /agent/chat 一致：回写一轮对话供下轮上下文与历史展示
            deps.chat_sessions.append_round(req.canvas_id, req.prompt, result.message)
            q.put({
                "type": "done",
                "success": result.success,
                "stopped": result.stopped,
                "message": result.message,
                "canvas": result.state.to_dict(),
                "steps": result.steps,
            })
        except Exception as e:
            # worker 异常也必须发 done，否则前端会一直等
            logger.exception("Agent 流式对话执行异常")
            q.put({
                "type": "done",
                "success": False,
                "message": f"Agent 执行失败：{e}",
                "steps": [],
            })
        finally:
            q.put(None)

    threading.Thread(
        target=worker, daemon=True, name=f"agent-stream-{req.canvas_id[:8]}"
    ).start()

    def sse():
        finished = False
        try:
            yield _sse({"type": "start"})
            while True:
                evt = q.get()
                if evt is None:
                    finished = True
                    return
                yield _sse(evt)
        finally:
            # 客户端断开（关页面/刷新/网络中断）视为放弃：
            # 请求停止后台执行，避免白烧模型与生图额度
            if not finished:
                deps.agent.control.request_stop(req.canvas_id)

    return StreamingResponse(sse(), media_type="text/event-stream")


@router.post("/agent/stop", summary="停止当前画布正在执行的 Agent 任务")
def stop_agent(req: StopRequest):
    # 停止在下一个操作边界生效（当前正在执行的生图等长操作会先完成）
    stopped = deps.agent.control.request_stop(req.canvas_id)
    return {
        "success": True,
        "message": "已请求停止，正在等待当前操作完成" if stopped else "当前没有正在执行的任务",
    }


@router.get("/agent/history", summary="获取画布对话历史")
def get_agent_history(canvas_id: str):
    return {"canvas_id": canvas_id, "messages": deps.chat_sessions.get_messages(canvas_id)}


@router.delete("/agent/history", summary="清空画布对话历史")
def clear_agent_history(canvas_id: str):
    deps.chat_sessions.clear(canvas_id)
    return {"success": True, "message": "已清空对话历史"}


# ==================== 大模型服务商设置 ====================


class LLMConfigRequest(BaseModel):
    provider: str = ""  # ""=未设置（回退 .env/Mock），"mock"=显式 Mock，其余为预设 key
    api_key: str = ""
    base_url: str = ""
    model: str = ""


class ImageConfigRequest(BaseModel):
    provider: str = ""
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    stream_model: str = ""


class SettingsRequest(BaseModel):
    llm: LLMConfigRequest
    image: ImageConfigRequest


def _masked_settings() -> dict:
    """当前用户设置（key 脱敏）+ 生效状态"""
    s = deps.manager.settings
    return {
        "llm": {
            "provider": s.llm.provider,
            "api_key": mask_key(s.llm.api_key),
            "base_url": s.llm.base_url,
            "model": s.llm.model,
        },
        "image": {
            "provider": s.image.provider,
            "api_key": mask_key(s.image.api_key),
            "base_url": s.image.base_url,
            "model": s.image.model,
            "stream_model": s.image.stream_model,
        },
        "status": deps.manager.status(),
    }


def _parse_settings(req: SettingsRequest) -> AppSettings:
    """请求数据 → AppSettings：校验 provider、补预设默认值、脱敏占位符保留原 key"""
    if req.llm.provider not in PROVIDER_PRESETS and req.llm.provider not in ("", "mock"):
        raise HTTPException(status_code=400, detail=f"未知的 LLM 服务商: {req.llm.provider}")
    if req.image.provider not in PROVIDER_PRESETS and req.image.provider not in ("", "mock"):
        raise HTTPException(status_code=400, detail=f"未知的图片服务商: {req.image.provider}")

    old = deps.manager.settings
    llm = LLMConfig(
        provider=req.llm.provider,
        api_key=req.llm.api_key,
        base_url=req.llm.base_url,
        model=req.llm.model,
    )
    image = ImageConfig(
        provider=req.image.provider,
        api_key=req.image.api_key,
        base_url=req.image.base_url,
        model=req.image.model,
        stream_model=req.image.stream_model,
    )
    # key 传回脱敏占位符（含 ****）或留空时保留原值，便于只改模型不动 key
    if llm.provider not in ("", "mock"):
        if "****" in llm.api_key or not llm.api_key:
            llm.api_key = old.llm.api_key if old.llm.provider == llm.provider else ""
        if not llm.api_key:
            raise HTTPException(status_code=400, detail="LLM 服务商已选择，请填写 API Key")
        resolve_preset(llm, is_image=False)
    else:
        llm.api_key = ""  # 未设置/显式 Mock 不保留 key
    if image.provider not in ("", "mock"):
        if (PROVIDER_PRESETS.get(image.provider) or {}).get("image_api") is None:
            raise HTTPException(
                status_code=400,
                detail=f"服务商 {image.provider} 不支持图片生成，请选择其他服务商或 Mock",
            )
        if "****" in image.api_key or not image.api_key:
            image.api_key = old.image.api_key if old.image.provider == image.provider else ""
        if not image.api_key:
            raise HTTPException(status_code=400, detail="图片服务商已选择，请填写 API Key")
        resolve_preset(image, is_image=True)
    else:
        image.api_key = ""
    return AppSettings(llm=llm, image=image)


@router.get("/experiences", summary="列出风格库（热加载：每次重扫目录）")
def list_experiences_route():
    return {"experiences": experiences.list_experiences()}


@router.post("/experiences", summary="导入风格 MD（立即生效）")
def add_experience_route(req: ExperienceIn):
    try:
        item = experiences.add_experience(req.name, req.description, req.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "experience": item}


@router.put("/experiences/{exp_id}", summary="编辑风格名称/描述")
def update_experience_route(exp_id: str, req: ExperienceUpdate):
    try:
        item = experiences.update_experience(exp_id, req.name, req.description)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not item:
        raise HTTPException(status_code=404, detail="风格不存在")
    return {"success": True, "experience": item}


@router.delete("/experiences/{exp_id}", summary="删除风格")
def delete_experience_route(exp_id: str):
    ok = experiences.delete_experience(exp_id)
    if not ok:
        raise HTTPException(status_code=404, detail="风格不存在")
    return {"success": True, "message": "已删除"}


@router.get("/settings", summary="获取当前大模型配置（key 脱敏）")
def get_settings():
    return _masked_settings()


@router.put("/settings", summary="保存大模型配置并热切换（无需重启）")
def put_settings(req: SettingsRequest):
    settings = _parse_settings(req)
    deps.manager.update(settings)
    return {"success": True, "message": "配置已保存并生效", "settings": _masked_settings()}


@router.delete("/settings", summary="清除用户配置（回退 .env / Mock）")
def delete_settings():
    deps.manager.reset()
    return {"success": True, "message": "已恢复默认配置", "settings": _masked_settings()}


@router.get("/providers", summary="获取内置服务商预设列表")
def get_providers():
    return {"providers": PROVIDER_PRESETS}


def _err_snippet(resp: requests.Response) -> str:
    return resp.text[:200].replace("\n", " ")


@router.post("/settings/test", summary="测试配置连通性（不保存）")
def test_settings(req: SettingsRequest):
    """LLM 发 1 token 轻量对话验证；图片服务探测 /models 列表接口"""
    result: dict = {"llm": {}, "image": {}}

    # ---- LLM 测试 ----
    if req.llm.provider in ("", "mock"):
        result["llm"] = {
            "ok": True,
            "message": "未设置（当前跟随 .env / Mock），无需测试",
        }
    else:
        llm = LLMConfig(
            provider=req.llm.provider,
            api_key=req.llm.api_key,
            base_url=req.llm.base_url,
            model=req.llm.model,
        )
        if "****" in llm.api_key or not llm.api_key:
            old = deps.manager.settings
            llm.api_key = old.llm.api_key if old.llm.provider == llm.provider else ""
        resolve_preset(llm, is_image=False)
        if not llm.api_key or not llm.base_url:
            result["llm"] = {"ok": False, "message": "请填写 API Key 和 Base URL"}
        else:
            try:
                session = requests.Session()
                session.trust_env = False
                resp = session.post(
                    f"{llm.base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {llm.api_key}"},
                    json={
                        "model": llm.model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                    timeout=30,
                    proxies={"http": None, "https": None},
                )
                if resp.status_code == 200:
                    result["llm"] = {"ok": True, "message": f"连接成功（{llm.model}）"}
                elif resp.status_code in (401, 403):
                    result["llm"] = {"ok": False, "message": "API Key 无效或无权限"}
                else:
                    result["llm"] = {
                        "ok": False,
                        "message": f"HTTP {resp.status_code}: {_err_snippet(resp)}",
                    }
            except requests.RequestException as e:
                result["llm"] = {"ok": False, "message": f"连接失败: {e}"}

    # ---- 图片服务测试 ----
    if req.image.provider in ("", "mock"):
        result["image"] = {
            "ok": True,
            "message": "未设置（当前跟随 .env / Mock），无需测试",
        }
    else:
        image = ImageConfig(
            provider=req.image.provider,
            api_key=req.image.api_key,
            base_url=req.image.base_url,
            model=req.image.model,
        )
        if "****" in image.api_key or not image.api_key:
            old = deps.manager.settings
            image.api_key = old.image.api_key if old.image.provider == image.provider else ""
        resolve_preset(image, is_image=True)
        if not image.api_key or not image.base_url:
            result["image"] = {"ok": False, "message": "请填写 API Key 和 Base URL"}
        else:
            try:
                session = requests.Session()
                session.trust_env = False
                resp = session.get(
                    f"{image.base_url.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {image.api_key}"},
                    timeout=30,
                    proxies={"http": None, "https": None},
                )
                if resp.status_code == 200:
                    result["image"] = {"ok": True, "message": f"连接成功（{image.model}）"}
                elif resp.status_code in (401, 403):
                    result["image"] = {"ok": False, "message": "API Key 无效或无权限"}
                elif resp.status_code in (404, 405):
                    result["image"] = {
                        "ok": True,
                        "message": "接口连通（该服务商不提供模型列表接口，未深度验证）",
                    }
                else:
                    result["image"] = {
                        "ok": False,
                        "message": f"HTTP {resp.status_code}: {_err_snippet(resp)}",
                    }
            except requests.RequestException as e:
                result["image"] = {"ok": False, "message": f"连接失败: {e}"}

    return result


# ===== 模型名称查询（服务商 /models 接口优先，Ark 回退内置常见列表） =====

class ModelsQueryRequest(BaseModel):
    kind: str = "llm"            # "llm" | "image"（image 时 stream_model 也用同一列表）
    provider: str = ""
    api_key: str = ""
    base_url: str = ""


# 火山方舟未开放 GET /models 列表接口，回退到内置常见模型（模型迭代后可按需增补）
ARK_FALLBACK_MODELS: dict[str, list[str]] = {
    "llm": [
        "doubao-seed-2-1-pro-260915",
        "doubao-seed-1-6-250615",
        "doubao-seed-1-6-flash-250715",
        "doubao-seed-1-6-thinking-250615",
        "deepseek-v3-250324",
        "deepseek-r1-250528",
    ],
    "image": [
        "doubao-seedream-5-0-pro-260628",
        "doubao-seedream-5-0-lite-260708",
        "doubao-seedream-4-0-250920",
        "doubao-seededit-3-0-i2i-250628",
    ],
}

# /models 常返回全家桶（含 embedding/音频等），黑名单过滤提升选择体验
_MODEL_ID_BLACKLIST = ("embedding", "rerank", "whisper", "tts", "moderation", "audio")


def _extract_model_ids(resp: requests.Response) -> list[str]:
    """解析 OpenAI 兼容 /models 响应：{"data": [{"id": ...}]} 或直接数组"""
    try:
        data = resp.json()
    except ValueError:
        return []
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    ids = []
    for item in items:
        mid = item.get("id") if isinstance(item, dict) else item
        if isinstance(mid, str) and mid and not any(k in mid.lower() for k in _MODEL_ID_BLACKLIST):
            ids.append(mid)
    return sorted(set(ids))


@router.post("/models", summary="查询服务商可用模型名称列表（供下拉选择）")
def list_models(req: ModelsQueryRequest):
    if req.kind not in ("llm", "image"):
        raise HTTPException(status_code=400, detail="kind 必须为 llm 或 image")
    if req.provider in ("", "mock"):
        raise HTTPException(status_code=400, detail="请先选择服务商")
    if req.provider not in PROVIDER_PRESETS:
        raise HTTPException(status_code=400, detail=f"未知的服务商: {req.provider}")

    # key 传回脱敏占位符（含 ****）或留空时，复用已保存的真实 key（服务商未变时）
    api_key = req.api_key
    if "****" in api_key or not api_key:
        saved = deps.manager.settings.image if req.kind == "image" else deps.manager.settings.llm
        api_key = saved.api_key if saved.provider == req.provider else ""
    base_url = req.base_url or (PROVIDER_PRESETS[req.provider].get("base_url") or "")

    # 火山方舟未开放 /models 列表接口（且对未知路径也返回 401，无法区分 key 有效性），
    # 直接返回内置常见模型，无需 key 即可选择
    if req.provider == "ark":
        return {
            "models": ARK_FALLBACK_MODELS[req.kind],
            "source": "preset",
            "message": "火山方舟未开放模型列表接口，以下为内置常见模型（以控制台实际开通为准）",
        }

    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写 API Key")
    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写 Base URL")

    try:
        session = requests.Session()
        session.trust_env = False
        resp = session.get(
            f"{base_url.rstrip('/')}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30,
            proxies={"http": None, "https": None},
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"连接失败: {e}")

    if resp.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="API Key 无效或无权限")
    if resp.status_code == 200:
        models = _extract_model_ids(resp)
        if models:
            return {"models": models, "source": "api"}
    elif resp.status_code not in (404, 405):
        raise HTTPException(status_code=502, detail=f"HTTP {resp.status_code}: {_err_snippet(resp)}")

    # 列表接口不可用（404/405 或返回空）：提示手动输入
    return {
        "models": [],
        "source": "none",
        "message": "该服务商未提供模型列表接口，请手动输入模型名称",
    }


# ===== 打开图片所在文件夹（系统文件管理器定位该文件） =====

class RevealImageRequest(BaseModel):
    url: str  # 画布节点的 image_url（本服务托管的 /images/ 地址）


@router.post("/reveal-image", summary="在系统文件管理器中打开图片所在文件夹并定位该文件")
def reveal_image(req: RevealImageRequest):
    from app.image.files import IMAGES_DIR, is_local_image_url, _rel_from_url

    url = req.url
    if not is_local_image_url(url):
        raise HTTPException(status_code=400, detail="该图片不在本地存储（远程图片或尚未落盘）")

    # 解析为 images 下的相对路径：{canvas_id}/{name}（新结构）或 {name}（旧平铺结构），
    # 同时完成路径穿越校验，不能只取末段文件名，否则会丢掉 canvas_id 子目录。
    try:
        rel = _rel_from_url(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    images_root = IMAGES_DIR.resolve()
    path = (IMAGES_DIR / rel).resolve()
    if not path.is_relative_to(images_root):
        raise HTTPException(status_code=400, detail=f"非法图片地址: {url}")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="本地图片文件不存在（可能已被清理）")

    try:
        if sys.platform == "win32":
            # explorer /select：打开所在文件夹并高亮选中该文件
            subprocess.Popen(["explorer", "/select,", str(path)])
        elif sys.platform == "darwin":
            # macOS Finder：选中该文件
            subprocess.Popen(["open", "-R", str(path)])
        else:
            # Linux 无统一"定位"命令，退化为打开所在目录
            subprocess.Popen(["xdg-open", str(path.parent)])
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"无法打开文件管理器: {e}")

    return {"success": True, "message": f"已在文件管理器中定位 {path.name}"}


# ===== 前端日志上报（合流写入 backend/data/logs/app.log，[frontend] 标记来源） =====

_front_logger = logging.getLogger("frontend")

# 单条消息/堆栈截断上限：防止整段 base64 或超大堆栈刷爆日志文件
_MAX_CLIENT_MSG = 2000
_MAX_CLIENT_STACK = 4000
_MAX_BATCH = 50


class ClientLogItem(BaseModel):
    level: str = "info"            # info | warn | error
    message: str
    stack: Optional[str] = None
    url: Optional[str] = None      # 发生页面地址（含 canvas 参数）
    canvas_id: Optional[str] = None
    ts: Optional[float] = None     # 客户端时间戳（毫秒）


class ClientLogsRequest(BaseModel):
    logs: List[ClientLogItem]


@router.post("/client_logs", summary="接收前端错误/日志上报（批量写入 app.log）")
def receive_client_logs(req: ClientLogsRequest):
    accepted = 0
    for item in req.logs[:_MAX_BATCH]:
        line = item.message[:_MAX_CLIENT_MSG]
        extras = []
        if item.url:
            extras.append(f"url={item.url[:200]}")
        if item.canvas_id:
            extras.append(f"canvas={item.canvas_id}")
        if extras:
            line = f"{line} ({' '.join(extras)})"
        stack = (item.stack or "")[:_MAX_CLIENT_STACK]
        if stack:
            line = f"{line}\n{stack}"
        level = item.level.lower()
        if level == "error":
            _front_logger.error(line)
        elif level == "warn":
            _front_logger.warning(line)
        else:
            _front_logger.info(line)
        accepted += 1
    return {"success": True, "accepted": accepted}


# ==================== 画布快照管理 ====================


class SnapshotRequest(BaseModel):
    name: str = ""  # 快照名称（可选，缺省自动生成时间戳名称）


@router.post("/canvas/{canvas_id}/snapshots", summary="保存画布快照")
def save_canvas_snapshot(canvas_id: str, req: SnapshotRequest):
    from app.canvas.snapshot import save_snapshot

    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    result = save_snapshot(state, req.name)
    return {"success": True, "snapshot": result}


@router.get("/canvas/{canvas_id}/snapshots", summary="列出画布的所有快照")
def list_canvas_snapshots(canvas_id: str):
    from app.canvas.snapshot import list_snapshots

    snapshots = list_snapshots(canvas_id)
    return {"snapshots": snapshots}


@router.get("/canvas/{canvas_id}/snapshots/{snapshot_id}", summary="获取快照详情")
def get_canvas_snapshot(canvas_id: str, snapshot_id: str):
    from app.canvas.snapshot import load_snapshot

    data = load_snapshot(canvas_id, snapshot_id)
    if not data:
        raise HTTPException(status_code=404, detail="快照不存在")
    return data


@router.post("/canvas/{canvas_id}/snapshots/{snapshot_id}/restore", summary="从快照恢复画布")
def restore_canvas_snapshot(canvas_id: str, snapshot_id: str):
    from app.canvas.snapshot import load_snapshot, restore_from_snapshot

    data = load_snapshot(canvas_id, snapshot_id)
    if not data:
        raise HTTPException(status_code=404, detail="快照不存在")

    # 恢复画布状态
    restored = restore_from_snapshot(data)
    deps.store.save_canvas(restored)
    return {
        "success": True,
        "message": f"已恢复到快照：{data['name']}",
        "canvas": restored.to_dict(),
    }


@router.delete("/canvas/{canvas_id}/snapshots/{snapshot_id}", summary="删除快照")
def delete_canvas_snapshot(canvas_id: str, snapshot_id: str):
    from app.canvas.snapshot import delete_snapshot

    ok = delete_snapshot(canvas_id, snapshot_id)
    if not ok:
        raise HTTPException(status_code=404, detail="快照不存在")
    return {"success": True, "message": "已删除快照"}
