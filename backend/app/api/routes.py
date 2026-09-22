"""REST API 路由"""
import json
import uuid
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import deps
from app.canvas.state import CanvasNode

router = APIRouter(prefix="/api", tags=["agent"])


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


class VariateRequest(BaseModel):
    node_id: str
    prompt: str = ""
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None


class EditRequest(BaseModel):
    node_id: str
    prompt: str
    size: str = "2K"


class GenerateRequest(BaseModel):
    prompt: str
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None


class StreamGenRequest(BaseModel):
    op: str  # "generate" | "variate" | "compose"
    prompt: str = ""
    size: str = "2K"
    x: float = 100
    y: float = 100
    node_id: Optional[str] = None
    node_ids: Optional[List[str]] = None


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _clamp_size(size: str) -> str:
    """流式模型（Seedream 5.0 Lite）总像素下限 3686400：不足时等比放大（32 倍数对齐）"""
    MIN_PIXELS = 3686400  # ≈1920x1920，Ark 报错信息给出的硬下限
    if size == "1K":
        return "2048x2048"
    try:
        if "x" in size:
            w, h = (int(v) for v in size.lower().split("x", 1))
            if w * h < MIN_PIXELS:
                scale = (MIN_PIXELS / (w * h)) ** 0.5
                w = max(32, -(-int(w * scale) // 32) * 32)  # 向上取整到 32 倍数
                h = max(32, -(-int(h * scale) // 32) * 32)
                while w * h < MIN_PIXELS:  # 对齐后仍不足则继续加
                    if w <= h:
                        w += 32
                    else:
                        h += 32
                return f"{w}x{h}"
    except ValueError:
        pass
    return size


@router.post("/canvas", summary="创建新画布")
def create_canvas():
    state = deps.store.create_canvas()
    return {"canvas_id": state.canvas_id}


@router.get("/canvas/{canvas_id}", summary="获取画布状态")
def get_canvas(canvas_id: str):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return state.to_dict()


@router.patch("/canvas/{canvas_id}/node/{node_id}", summary="更新节点位置")
def update_node(canvas_id: str, node_id: str, req: UpdateNodeRequest):
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
    kwargs = {"node_ids": req.node_ids, "prompt": req.prompt, "size": req.size}
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
    result = tool.run(state, node_id=req.node_id, prompt=req.prompt, size=req.size)
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


@router.post("/canvas/{canvas_id}/nodes/delete", summary="批量删除节点（单次撤销）")
def batch_delete_nodes(canvas_id: str, req: BatchDeleteRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    deleted = 0
    for nid in req.node_ids:
        node = state.get_node(nid)
        if node:
            state.remove_node(nid)
            deleted += 1
    if deleted > 0:
        deps.store.save_canvas(state)
    return {
        "success": True,
        "message": f"已删除 {deleted} 张图片",
        "canvas": state.to_dict(),
    }


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


@router.post("/canvas/{canvas_id}/generate", summary="文生图（直接执行，不走 Agent）")
def generate_image(canvas_id: str, req: GenerateRequest):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    tool = deps.tool_manager.get("generate_image")
    kwargs = {"prompt": req.prompt, "size": req.size}
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
        prompt = req.prompt
        source_descs = [n.content for n in sources if n.content]
        if source_descs and not prompt:
            prompt = "融合以下内容生成一张新图：" + "；".join(source_descs)
        elif source_descs and prompt:
            prompt = f"{prompt}。参考内容：{'；'.join(source_descs)}"
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

    size = _clamp_size(req.size)

    def _add_node(image_url: str, w: int, h: int) -> None:
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
        state.add_node(node)

    gen = deps.image_generator

    def sse():
        # 流式模式：支持 SSE 的真实 generator 逐预览推送
        if hasattr(gen, "generate_stream"):
            yield _sse({"type": "start", "mode": "stream"})
            try:
                for evt in gen.generate_stream(
                    prompt, image_urls=ref_urls, width=width, height=height, size=size
                ):
                    if evt["type"] == "preview":
                        yield _sse(evt)
                    else:
                        result = evt["result"]
                        _add_node(result.image_url, result.width, result.height)
                        deps.store.save_canvas(state)
                        yield _sse(
                            {
                                "type": "done",
                                "success": True,
                                "message": "生成完成",
                                "canvas": state.to_dict(),
                            }
                        )
                        return
            except ValueError:
                # 流式不可用（模型不支持等）→ 回退非流式
                pass
            except Exception as e:
                yield _sse({"type": "done", "success": False, "message": f"生成失败：{e}"})
                return

        # 估算模式：无流式能力（Mock / 回退），前端用估算进度条
        yield _sse({"type": "start", "mode": "estimated"})
        if req.op == "compose":
            tool = deps.tool_manager.get("compose_images")
            result = tool.run(
                state, node_ids=req.node_ids or [], prompt=req.prompt, size=size, x=req.x, y=req.y
            )
        elif req.op == "variate":
            tool = deps.tool_manager.get("variate_image")
            result = tool.run(
                state, node_id=req.node_id or "", prompt=req.prompt, size=size, x=req.x, y=req.y
            )
        else:
            tool = deps.tool_manager.get("generate_image")
            result = tool.run(state, prompt=prompt, size=size, x=req.x, y=req.y)
        if result.success:
            deps.store.save_canvas(result.state)
        yield _sse(
            {
                "type": "done",
                "success": result.success,
                "message": result.message,
                "canvas": result.state.to_dict(),
            }
        )

    return StreamingResponse(sse(), media_type="text/event-stream")


@router.post("/agent/chat", response_model=ChatResponse, summary="发送提示词给 Agent")
def chat(req: ChatRequest):
    try:
        result = deps.agent.run(req.prompt, req.canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return ChatResponse(
        success=result.success,
        message=result.message,
        canvas=result.state.to_dict(),
        steps=result.steps,
    )
