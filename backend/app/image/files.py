"""图片落盘存储：base64 data URL → backend/data/images 文件 + http URL

画布 JSON 只存图片 URL（KB 级），避免 base64 内嵌导致 JSON 膨胀到几十 MB
（每次 API 响应全量传输、每次保存全量重写磁盘都会被拖慢）。
图片目录与画布数据同目录（backend/data/images），已被 .gitignore 覆盖。

生图 API 参考图注意：远端服务器无法访问本地 URL，
传参前须用 to_sendable_ref() 把本地图片转回内联 data URL。
"""
from __future__ import annotations

import base64
import os
import uuid
from pathlib import Path

from app.canvas.state import CanvasState


def _images_dir() -> Path:
    # 优先跟随 CANVAS_DATA_DIR（画布数据目录的兄弟目录），与 settings.json 同级策略
    env_dir = os.getenv("CANVAS_DATA_DIR")
    if env_dir:
        return Path(env_dir).parent / "images"
    return Path(__file__).resolve().parent.parent.parent / "data" / "images"


IMAGES_DIR = _images_dir()

# 对外访问基础地址（与前端 API_BASE 保持一致，可改端口后用环境变量覆盖）
PUBLIC_BASE = os.getenv("CANVAS_PUBLIC_BASE", "http://127.0.0.1:8000").rstrip("/")

_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
_MIME_FROM_EXT = {v: k for k, v in _EXT.items()}


def save_data_image(data_url: str) -> str:
    """base64 data URL → 落盘文件，返回 http URL"""
    header, _, b64 = data_url.partition(",")
    mime = header[5:].split(";", 1)[0] or "image/png"
    content = base64.b64decode(b64)
    name = f"{uuid.uuid4().hex}.{_EXT.get(mime, 'png')}"
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    (IMAGES_DIR / name).write_bytes(content)
    return f"{PUBLIC_BASE}/images/{name}"


def is_local_image_url(url: str) -> bool:
    """是否为本服务托管的图片 URL（本地地址 + /images/ 前缀）"""
    for prefix in (
        f"{PUBLIC_BASE}/images/",
        "http://127.0.0.1/images/",
        "http://localhost/images/",
    ):
        if url.startswith(prefix):
            return True
    return False


def local_url_to_data_url(url: str) -> str:
    """本地图片 URL → 内联 data URL（供生图 API 参考图使用）"""
    name = url.rsplit("/", 1)[-1]
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"非法图片地址: {url}")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "png"
    mime = _MIME_FROM_EXT.get(ext, "image/png")
    content = (IMAGES_DIR / name).read_bytes()
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"


def to_sendable_ref(url: str) -> str:
    """归一化参考图：data URL 原样；本地托管 URL → data URL；远端 http URL 原样"""
    if url.startswith("data:"):
        return url
    if is_local_image_url(url):
        return local_url_to_data_url(url)
    return url


def materialize_state_images(state: CanvasState) -> int:
    """把画布内 data URL 节点图片落盘为文件（原地替换为 http URL），返回转换数（幂等）"""
    count = 0
    for node in state.nodes.values():
        url = node.image_url
        if url and url.startswith("data:image/"):
            try:
                node.image_url = save_data_image(url)
                count += 1
            except (ValueError, OSError):
                # 单张落盘失败保留 data URL，不影响保存画布
                pass
    return count
