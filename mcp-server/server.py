"""画布 MCP 服务器：让 Codex 等 AI 客户端在无限画布上绘制需求文档初稿。

架构（薄壳转发）：
    Codex ←stdio→ 本进程 ←localhost HTTP→ 画布后端 FastAPI(127.0.0.1:8000)
    后端是画布状态的唯一事实源，前端/AI对话/Codex 三方共享同一份数据。

Codex 配置（~/.codex/config.toml）：
    [mcp_servers.canvas]
    command = "C:\\Path\\To\\mcp-server\\.venv\\Scripts\\python.exe"
    args = ["D:\\lxz\\drama\\canvas\\mcp-server\\server.py"]

环境变量：
    CANVAS_API_BASE  后端 API 地址（默认 http://127.0.0.1:8000/api）
    CANVAS_MCP_GEN_CONCURRENCY  批量生图并发数（默认 2）
"""
from __future__ import annotations

import asyncio
import os

import httpx
from mcp.server.fastmcp import FastMCP

API_BASE = os.getenv("CANVAS_API_BASE", "http://127.0.0.1:8000/api")
# 生图耗时（数十秒）且共享 generator 实例，并发不宜高
GEN_CONCURRENCY = max(1, int(os.getenv("CANVAS_MCP_GEN_CONCURRENCY", "2")))
# 生图请求单独的长超时；普通 CRUD 用短超时
_TIMEOUT_FAST = httpx.Timeout(30.0)
_TIMEOUT_GEN = httpx.Timeout(600.0)

mcp = FastMCP("drama-canvas")

_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(base_url=API_BASE)
    return _client


async def _call(
    method: str,
    path: str,
    json_body: dict | None = None,
    params: dict | None = None,
    timeout: httpx.Timeout = _TIMEOUT_FAST,
) -> dict:
    """调用画布后端；连接失败/非 2xx 抛 RuntimeError（Codex 会看到清晰的错误原因）"""
    client = _http()
    try:
        resp = await client.request(
            method, path, json=json_body, params=params, timeout=timeout
        )
    except httpx.HTTPError as e:
        raise RuntimeError(
            f"画布后端连接失败（{API_BASE}，{e.__class__.__name__}）。"
            f"请先启动画布后端：运行 start_windows.bat 后重试。"
        ) from e
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text[:200])
        except Exception:
            detail = resp.text[:200]
        raise RuntimeError(f"画布后端返回 {resp.status_code}: {detail}")
    return resp.json()


def _brief_canvas(data: dict) -> dict:
    """压缩 /canvas/{id} 全量响应为精简结果（去掉 nodes 明细，防上下文膨胀）"""
    return {
        "canvas_id": data.get("canvas_id"),
        "name": data.get("name"),
        "version": data.get("version"),
        "node_count": len(data.get("nodes") or {}),
    }


@mcp.tool()
async def list_canvases() -> dict:
    """列出所有画布（canvas_id、名称、节点数、更新时间），按最近更新排序。
    用于决定复用已有画布还是新建。"""
    data = await _call("GET", "/canvas")
    items = [
        {
            "canvas_id": c.get("canvas_id"),
            "name": c.get("name"),
            "node_count": c.get("node_count"),
        }
        for c in data
    ]
    return {"count": len(items), "canvases": items}


@mcp.tool()
async def create_canvas(name: str) -> dict:
    """创建新画布，返回 canvas_id。name 用需求文档的简称（如"XX商城改版初稿"）。
    后续所有工具调用都传这个 canvas_id。"""
    if not name.strip():
        raise RuntimeError("画布名称不能为空")
    data = await _call("POST", "/canvas", json_body={"name": name.strip()})
    return {"canvas_id": data["canvas_id"], "name": data["name"]}


@mcp.tool()
async def get_canvas(canvas_id: str) -> dict:
    """获取画布精简视图：节点列表（#编号、类型、坐标、内容截断 100 字、连线来源 #N）。
    规划布局、引用已有节点、检查初稿结果时调用；节点用 "#编号" 指代（如 #3）。"""
    return await _call("GET", f"/canvas/{canvas_id}", params={"summary": "1"})


@mcp.tool()
async def add_text_nodes(canvas_id: str, nodes: list[dict]) -> dict:
    """批量添加文本卡片（需求初稿主干，单次调用放一批）。

    nodes 数组每项字段：
      - content: str 必填，卡片文本（支持换行）
      - x, y: number 可选，世界坐标；缺省时后端自动寻找空白位置（推荐：第一批不给坐标，
        之后用 get_canvas 查看落点再补第二批，或自算网格坐标：列宽约 340、行高约 220）
      - width, height: number 可选，默认 280x160
      - parent_ids: list[str] 可选，连线来源（"#N" 编号或节点 ID），如 ["#1", "#3"]
    返回 created 列表（含 node_id 与分配到的编号 index）。
    """
    if not nodes:
        raise RuntimeError("nodes 不能为空")
    data = await _call(
        "POST", f"/canvas/{canvas_id}/nodes/text", json_body={"nodes": nodes}
    )
    return {
        "success": True,
        "message": data.get("message"),
        "created": [
            {"node_id": c["node_id"], "index": c["index"], "x": c["x"], "y": c["y"]}
            for c in data.get("created", [])
        ],
        "warning": data.get("warning"),
    }


@mcp.tool()
async def update_nodes(canvas_id: str, updates: list[dict]) -> dict:
    """批量更新已有节点（局部修改初稿：改文案/移动/调尺寸/增删连线）。

    updates 数组每项字段：
      - node_id: str 必填（"#N" 编号或节点 ID）
      - x, y, width, height: number 可选
      - content: str 可选（整体替换）
      - source_ids: list[str] 可选（整体覆盖连线来源）
    """
    if not updates:
        raise RuntimeError("updates 不能为空")
    return await _call(
        "POST", f"/canvas/{canvas_id}/nodes/update", json_body={"updates": updates}
    )


@mcp.tool()
async def delete_nodes(canvas_id: str, node_ids: list[str]) -> dict:
    """批量删除节点。node_ids 支持 "#N" 编号或节点 ID，如 ["#5", "a1b2c3..."]。"""
    if not node_ids:
        raise RuntimeError("node_ids 不能为空")
    data = await _call(
        "POST", f"/canvas/{canvas_id}/nodes/delete", json_body={"node_ids": node_ids}
    )
    return {"success": data.get("success"), "message": data.get("message")}


@mcp.tool()
async def arrange_canvas(canvas_id: str) -> dict:
    """自动整理画布：按连线层级 DAG 分层布局（根节点在顶、派生向下，纵向族谱）。
    初稿卡片全部放完后调用一次即可获得整齐布局。"""
    data = await _call("POST", f"/canvas/{canvas_id}/arrange")
    return {"success": data.get("success"), "message": data.get("message")}


@mcp.tool()
async def generate_images(canvas_id: str, images: list[dict]) -> dict:
    """批量生成概念图并落到画布（走画布已配置的生图服务商与风格库）。

    images 数组每项字段：
      - prompt: str 必填，图片描述（前端用户可直接基于它再编辑）
      - x, y: number 可选，落点世界坐标；缺省自动寻找空白位置
      - size: str 可选，"1K"/"2K"/"4K" 或 "宽x高"（如 2048x1152），默认 2K
      - experience_ids: list[str] 可选，画布风格库 ID
    并发执行（受 CANVAS_MCP_GEN_CONCURRENCY 限制）；每张返回编号 #N 供后续引用连线。
    注意：生图耗时长（每张可达数十秒），一次批量建议 ≤ 5 张。
    """
    if not images:
        raise RuntimeError("images 不能为空")
    sem = asyncio.Semaphore(GEN_CONCURRENCY)
    results: list[dict] = []

    async def _one(prompt: str, x, y, size, experience_ids) -> None:
        body: dict = {"prompt": prompt, "size": size or "2K"}
        if x is not None:
            body["x"] = x
        if y is not None:
            body["y"] = y
        if experience_ids:
            body["experience_ids"] = experience_ids
        async with sem:
            try:
                data = await _call(
                    "POST", f"/canvas/{canvas_id}/generate", json_body=body,
                    timeout=_TIMEOUT_GEN,
                )
            except RuntimeError as e:
                results.append({"success": False, "prompt": prompt[:50], "error": str(e)})
                return
        # 从返回画布中找出新增图片节点（按内容=原始 prompt 匹配最稳）
        new_nodes = [
            n
            for n in (data.get("canvas", {}).get("nodes") or {}).values()
            if n.get("type") == "image" and n.get("content") == prompt
        ]
        node = new_nodes[-1] if new_nodes else None
        results.append(
            {
                "success": data.get("success", False),
                "prompt": prompt[:50],
                "index": (node or {}).get("index"),
                "image_url": (node or {}).get("image_url"),
            }
        )

    await asyncio.gather(
        *[
            _one(
                img.get("prompt", ""),
                img.get("x"),
                img.get("y"),
                img.get("size"),
                img.get("experience_ids"),
            )
            for img in images
            if (img.get("prompt") or "").strip()
        ]
    )
    ok = sum(1 for r in results if r.get("success"))
    return {
        "success": ok == len(results),
        "message": f"已生成 {ok}/{len(results)} 张图片",
        "images": results,
    }


if __name__ == "__main__":
    mcp.run()  # stdio 模式，Codex 本地调用
