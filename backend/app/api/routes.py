"""REST API 路由"""
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import deps

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
