"""No-credit integration check: real CLI dry-run, MCP stdio, isolated canvas API."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

import httpx
from PIL import Image
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from openart_server import OUTPUT, ROOT, openart_import_image


def tool_data(result):
    assert not result.isError, result
    return json.loads(next(block.text for block in result.content if block.type == "text"))


async def check():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="openart-canvas-test-") as folder:
        env = dict(os.environ, CANVAS_DATA_DIR=str(Path(folder) / "canvases"),
                   CANVAS_AUTH_TOKEN="", CANVAS_PUBLIC_BASE=f"http://127.0.0.1:{port}")
        with open(Path(folder) / "backend.log", "w+") as log:
            backend = subprocess.Popen(
                [str(ROOT / "backend/.venv/bin/python"), "-m", "uvicorn", "app.main:app",
                 "--host", "127.0.0.1", "--port", str(port)],
                cwd=ROOT / "backend", env=env, stdout=log, stderr=log,
            )
            try:
                api = f"http://127.0.0.1:{port}/api"
                async with httpx.AsyncClient(base_url=api, timeout=5) as client:
                    for _ in range(60):
                        try:
                            response = await client.get("/canvas")
                            response.raise_for_status()
                            break
                        except httpx.HTTPError:
                            if backend.poll() is not None:
                                log.seek(0)
                                raise RuntimeError(log.read()[-3000:])
                            await asyncio.sleep(0.1)
                    else:
                        raise RuntimeError("Isolated backend did not start")
                    created = await client.post("/canvas", json={"name": "OpenArt integration test"})
                    created.raise_for_status()
                    canvas_id = created.json()["canvas_id"]
                    params = StdioServerParameters(
                        command=str(ROOT / "mcp-server/.venv/bin/python"),
                        args=[str(ROOT / "mcp-server/openart_server.py")],
                        env=dict(os.environ, CANVAS_API_BASE=api),
                    )
                    async with stdio_client(params) as (reader, writer):
                        async with ClientSession(reader, writer) as session:
                            await session.initialize()
                            tools = await session.list_tools()
                            assert len(tools.tools) == 6
                            preview = tool_data(await session.call_tool("openart_generate_image", {
                                "prompt": "--model this is literal prompt text", "model": "nano-banana-2",
                            }))
                            assert preview["dry_run"] is True
                            assert preview["result"]["body"]["params"]["prompt"] == "--model this is literal prompt text"
                            listing = tool_data(await session.call_tool("openart_list_canvases", {}))
                            assert listing["canvases"][0]["canvas_id"] == canvas_id
                            OUTPUT.mkdir(parents=True, exist_ok=True)
                            with tempfile.TemporaryDirectory(dir=OUTPUT, prefix="test-") as images:
                                image_path = Path(images) / "reference.png"
                                Image.new("RGB", (800, 400), "#8c9a7e").save(image_path)
                                imported = tool_data(await session.call_tool("openart_import_image", {
                                    "canvas_id": canvas_id, "file_path": str(image_path), "x": 120, "y": 160,
                                }))
                                assert imported["success"] is True
                                saved = (await client.get(f"/canvas/{canvas_id}")).json()
                                node = next(iter(saved["nodes"].values()))
                                # Canvas storage caps displayed image size; aspect ratio is retained.
                                assert node["width"] / node["height"] == 2, node
                                assert (node["x"], node["y"]) == (120, 160), node
                                assert node["type"] == "image"
                    try:
                        await openart_import_image(canvas_id, "/tmp/outside-openart.png")
                    except ValueError:
                        pass
                    else:
                        raise AssertionError("Import accepted a path outside OpenArt outputs")
                    print("PASS: 6 MCP tools, CLI dry-run and literal prompt, canvas listing, image import/aspect ratio, path guard; no credits spent")
            finally:
                backend.terminate()
                backend.wait(timeout=10)


if __name__ == "__main__":
    asyncio.run(check())
