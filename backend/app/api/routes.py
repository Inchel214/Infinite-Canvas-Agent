"""REST API 路由"""
import json
import uuid
from typing import List, Optional

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import deps
from app import experiences
from app.canvas.state import CanvasNode
from app.providers.schema import (
    AppSettings,
    ImageConfig,
    LLMConfig,
    PROVIDER_PRESETS,
    mask_key,
    resolve_preset,
)

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
    experience_id: Optional[str] = None  # 风格库：选中后读全文拼接进 prompt


class VariateRequest(BaseModel):
    node_id: str
    prompt: str = ""
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_id: Optional[str] = None


class EditRequest(BaseModel):
    node_id: str
    prompt: str
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_id: Optional[str] = None


class GenerateRequest(BaseModel):
    prompt: str
    size: str = "2K"
    x: Optional[float] = None
    y: Optional[float] = None
    experience_id: Optional[str] = None


class StreamGenRequest(BaseModel):
    op: str  # "generate" | "variate" | "compose"
    prompt: str = ""
    size: str = "2K"
    x: float = 100
    y: float = 100
    node_id: Optional[str] = None
    node_ids: Optional[List[str]] = None
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


@router.post("/canvas", summary="创建新画布")
def create_canvas():
    # 默认名按现有数量递增，避免都叫"未命名"
    default_name = f"画布 {len(deps.store.list_canvases()) + 1}"
    state = deps.store.create_canvas(default_name)
    return {"canvas_id": state.canvas_id, "name": state.name}


@router.get("/canvas", summary="列出所有画布摘要")
def list_canvases():
    # 合并生图任务状态：前端据此显示画布红点（生成中 / 未查看新图）
    from app.tools import tasks as task_registry

    return [
        {**c, **task_registry.summary(c["canvas_id"])} for c in deps.store.list_canvases()
    ]


@router.get("/canvas/{canvas_id}", summary="获取画布状态")
def get_canvas(canvas_id: str):
    try:
        state = deps.store.get_canvas(canvas_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
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
    prompt = experiences.apply_experience(req.experience_id, req.prompt) if req.experience_id else req.prompt
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
    if req.experience_id:
        prompt = experiences.apply_experience(req.experience_id, prompt)
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
    prompt = experiences.apply_experience(req.experience_id, req.prompt) if req.experience_id else req.prompt
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
    prompt = experiences.apply_experience(req.experience_id, req.prompt) if req.experience_id else req.prompt
    kwargs = {"prompt": prompt, "size": req.size}
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

    size = req.size

    # 风格库：选中风格后读全文确定性拼接进 prompt（对三种 op 统一生效）
    if req.experience_id:
        prompt = experiences.apply_experience(req.experience_id, prompt)

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
                            _add_node(result.image_url, result.width, result.height)
                            deps.store.save_canvas(state)
                            _end_tracked(True)
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
                    # 流式不可用（模型不支持等）→ 平衡计数后回退非流式（工具装饰器重新跟踪）
                    _end_tracked(False)
                except Exception as e:
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
    item = experiences.update_experience(exp_id, req.name, req.description)
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
