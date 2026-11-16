"""Local MCP adapter for the official OpenArt CLI, with canvas image import."""
from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import uuid

import httpx
from PIL import Image
from mcp.server.fastmcp import FastMCP

ROOT = Path(__file__).resolve().parents[1]
CLI = os.getenv("OPENART_CLI", str(ROOT / ".runtime/openart/bin/openart"))
OUTPUT = ROOT / ".runtime/openart/outputs"
API_BASE = os.getenv("CANVAS_API_BASE", "http://127.0.0.1:8000/api")
mcp = FastMCP(
    "openart-canvas",
    instructions="OpenArt CLI adapter maintained locally; not an official OpenArt MCP. "
    "Inspect models and costs before generation. Generation defaults to dry_run=True. "
    "Use dry_run=False only for user-requested generation. Local reference images are "
    "uploaded to OpenArt during live generation. Import downloaded results into an "
    "explicit canvas_id; list canvases first. Do not retry timed-out paid jobs blindly.",
)


async def _run(*args: str, timeout: int = 60) -> dict:
    try:
        process = await asyncio.create_subprocess_exec(
            CLI, "--json", "--no-input", "--timeout", f"{timeout}s", *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"OpenArt CLI not found: {CLI}") from exc
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout + 10)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise RuntimeError("OpenArt timed out. Check creation history before retrying; a job may already exist.") from exc
    if process.returncode:
        raise RuntimeError(stderr.decode(errors="replace")[-2000:] or "OpenArt command failed")
    try:
        return {"result": json.loads(stdout)}
    except (ValueError, UnicodeDecodeError):
        return {"output": stdout.decode(errors="replace")[:12000]}


@mcp.tool()
async def openart_account() -> dict:
    """Read OpenArt plan, credits and login status; does not generate media."""
    return await _run("account")


@mcp.tool()
async def openart_models() -> dict:
    """List current OpenArt models. Model IDs must come from this list."""
    return await _run("model", "list")


@mcp.tool()
async def openart_model_info(model: str, mode: str = "text2image") -> dict:
    """Read a model's accepted inputs and credit cost, without spending credits."""
    return {
        "form": await _run("model", "form", model, mode),
        "cost": await _run("model", "cost", "--model", model, "--mode", mode),
    }


@mcp.tool()
async def openart_generate_image(
    prompt: str, model: str, reference_images: list[str] | None = None,
    dry_run: bool = True,
) -> dict:
    """Generate via OpenArt and download results locally. dry_run=True only previews
    the request. dry_run=False spends OpenArt credits and uploads local reference
    files to OpenArt. Requires browser login through the project's login launcher.
    After live generation, use openart_import_image to place each file on a canvas.
    """
    if not prompt.strip() or not model.strip():
        raise ValueError("prompt and model are required")
    args = ["generate", "image", "--model", model]
    for ref in reference_images or []:
        args.extend(["--image", ref])
    if dry_run:
        args.append("--dry-run")
    else:
        destination = OUTPUT / uuid.uuid4().hex
        destination.mkdir(parents=True, exist_ok=False)
        args.extend(["--output", str(destination) + os.sep])
    # End option parsing so prompt text cannot introduce CLI flags.
    args.extend(["--", prompt])
    result = await _run(*args, timeout=300)
    if not dry_run:
        result["files"] = [str(p) for p in sorted(destination.rglob("*")) if p.is_file()]
        result["output_directory"] = str(destination)
    result["dry_run"] = dry_run
    return result


async def _canvas(method: str, path: str, **kwargs) -> dict | list:
    async with httpx.AsyncClient(base_url=API_BASE, timeout=30) as client:
        response = await client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()


@mcp.tool()
async def openart_list_canvases() -> dict:
    """List canvases so the user can select a destination before importing results."""
    data = await _canvas("GET", "/canvas")
    return {"canvases": [
        {k: item.get(k) for k in ("canvas_id", "name", "node_count")}
        for item in data
    ]}


@mcp.tool()
async def openart_import_image(
    canvas_id: str, file_path: str, x: float = 100, y: float = 100,
    display_width: int = 512, caption: str = "OpenArt",
) -> dict:
    """Import a downloaded OpenArt result into the specified canvas, retaining aspect
    ratio. Only files in this adapter's output directory are accepted. No generation.
    """
    path = Path(file_path).resolve()
    if not path.is_relative_to(OUTPUT.resolve()):
        raise ValueError("Only files from OpenArt output_directory can be imported")
    if not 1 <= display_width <= 4096:
        raise ValueError("display_width must be between 1 and 4096")
    if path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError("Image exceeds the 30 MB import limit")
    with Image.open(path) as image:
        image.verify()
        width, height = image.size
        mime = Image.MIME.get(image.format)
    if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise ValueError("Unsupported image format")
    payload = {
        "image_url": f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode(),
        "x": x, "y": y, "width": display_width,
        "height": max(1, round(display_width * height / width)), "content": caption,
    }
    data = await _canvas("POST", f"/canvas/{canvas_id}/upload_image", json=payload)
    return {"success": data.get("success"), "canvas_id": canvas_id,
            "message": data.get("message"), "file_path": str(path)}


if __name__ == "__main__":
    mcp.run()
