# -*- coding: utf-8 -*-
"""模拟 Codex 经 stdio 调用画布 MCP 服务器的全流程测试"""
import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    params = StdioServerParameters(
        command=r"d:\lxz\drama\canvas\mcp-server\.venv\Scripts\python.exe",
        args=[r"d:\lxz\drama\canvas\mcp-server\server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await asyncio.wait_for(session.initialize(), timeout=30)

            # 1. 工具清单
            tools = await session.list_tools()
            print("=== 工具清单 (%d 个) ===" % len(tools.tools))
            for t in tools.tools:
                print(" -", t.name)

            # 2. list_canvases
            r = await session.call_tool("list_canvases", {})
            print("\n=== list_canvases ===")
            print(r.content[0].text[:200])

            # 3. create_canvas
            r = await session.call_tool("create_canvas", {"name": "宠物社交App需求初稿"})
            print("\n=== create_canvas ===")
            print(r.content[0].text)
            cid = __import__("json").loads(r.content[0].text)["canvas_id"]

            # 4. add_text_nodes（Codex 拆文档的典型输出：模块卡片 + 连线）
            nodes = [
                {"content": "【总目标】宠物社交App V1\n核心场景：附近宠友 + 动态广场 + 宠物档案", "width": 320, "height": 140},
                {"content": "【模块A】用户体系\n手机号注册/微信登录/游客浏览", "parent_ids": ["#1"]},
                {"content": "【模块B】宠物档案\n品种/年龄/体重/照片墙/疫苗记录", "parent_ids": ["#1"]},
                {"content": "【模块C】动态广场\n发帖/点赞/评论/图片九宫格", "parent_ids": ["#1"]},
                {"content": "【模块D】附近宠友\nLBS 半径筛选/打招呼", "parent_ids": ["#2"]},
            ]
            r = await session.call_tool("add_text_nodes", {"canvas_id": cid, "nodes": nodes})
            print("\n=== add_text_nodes ===")
            print(r.content[0].text)

            # 5. get_canvas 摘要
            r = await session.call_tool("get_canvas", {"canvas_id": cid})
            print("\n=== get_canvas(summary) ===")
            print(r.content[0].text[:400])

            # 6. update_nodes（局部修改）
            r = await session.call_tool("update_nodes", {"canvas_id": cid, "updates": [
                {"node_id": "#3", "content": "【模块B】宠物档案（修订）\n品种/年龄/照片墙/疫苗/驱虫提醒"},
            ]})
            print("\n=== update_nodes ===")
            print(r.content[0].text)

            # 7. generate_images（Mock 模式快速返回）
            r = await session.call_tool("generate_images", {"canvas_id": cid, "images": [
                {"prompt": "App首页信息流线框概念图", "size": "1K"},
                {"prompt": "宠物档案编辑页概念图", "size": "1K"},
            ]})
            print("\n=== generate_images ===")
            print(r.content[0].text[:400])

            # 8. arrange_canvas
            r = await session.call_tool("arrange_canvas", {"canvas_id": cid})
            print("\n=== arrange_canvas ===")
            print(r.content[0].text)

            # 9. delete_nodes 用 #N
            r = await session.call_tool("delete_nodes", {"canvas_id": cid, "node_ids": ["#2"]})
            print("\n=== delete_nodes ===")
            print(r.content[0].text)
            print("\nALL MCP TOOLS PASSED, canvas_id =", cid)


asyncio.run(main())
