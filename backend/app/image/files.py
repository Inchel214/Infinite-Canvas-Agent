"""图片落盘存储：base64 data URL → backend/data/images 文件 + http URL

画布 JSON 只存图片 URL（KB 级），避免 base64 内嵌导致 JSON 膨胀到几十 MB
（每次 API 响应全量传输、每次保存全量重写磁盘都会被拖慢）。
图片目录与画布数据同目录（backend/data/images），已被 .gitignore 覆盖。

生图 API 参考图注意：远端服务器无法访问本地 URL，
传参前须用 to_sendable_ref() 把本地图片转回内联 data URL。
"""
from __future__ import annotations

import base64
import io
import logging
import os
import uuid
from pathlib import Path

from app.canvas.state import CanvasState

logger = logging.getLogger(__name__)


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


def save_data_image(data_url: str, canvas_id: str = "") -> str:
    """base64 data URL → 落盘到画布子目录，返回 http URL

    图片按画布归类（images/{canvas_id}/），画布删除时可整目录级联清理。
    canvas_id 为空时落到平铺根目录（兼容无画布上下文的调用）。
    """
    header, _, b64 = data_url.partition(",")
    mime = header[5:].split(";", 1)[0] or "image/png"
    content = base64.b64decode(b64)
    name = f"{uuid.uuid4().hex}.{_EXT.get(mime, 'png')}"
    rel = f"{canvas_id}/{name}" if canvas_id else name
    target = IMAGES_DIR / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return f"{PUBLIC_BASE}/images/{rel}"


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


def _rel_from_url(url: str) -> str:
    """本地图片 URL → images 目录下的相对路径（{canvas_id}/{name} 或旧平铺 {name}）"""
    # 取 /images/ 之后的部分：兼容带端口与不带端口的本地地址
    for prefix in (
        f"{PUBLIC_BASE}/images/",
        "http://127.0.0.1/images/",
        "http://localhost/images/",
    ):
        if url.startswith(prefix):
            rel = url[len(prefix):]
            break
    else:
        rel = url.rsplit("/images/", 1)[-1]
    # 安全校验：只允许一段或两段（目录/文件名），禁止穿越
    parts = rel.split("/")
    if not rel or "\\" in rel or any(p in ("", ".", "..") for p in parts) or len(parts) > 2:
        raise ValueError(f"非法图片地址: {url}")
    return rel


def _mime_from_rel(rel: str) -> str:
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else "png"
    return _MIME_FROM_EXT.get(ext, "image/png")


def local_url_to_data_url(url: str) -> str:
    """本地图片 URL → 内联 data URL（供生图 API 参考图使用）"""
    rel = _rel_from_url(url)
    content = (IMAGES_DIR / rel).read_bytes()
    return f"data:{_mime_from_rel(rel)};base64,{base64.b64encode(content).decode('ascii')}"


def to_sendable_ref(url: str) -> str:
    """归一化参考图：data URL 原样；本地托管 URL → data URL；远端 http URL 原样"""
    if url.startswith("data:"):
        return url
    if is_local_image_url(url):
        return local_url_to_data_url(url)
    return url


def image_display_size(url: str, max_edge: int = 400) -> tuple[int, int] | None:
    """读取图片真实宽高，等比缩放为画布节点尺寸。

    支持画布持久化后的本地 /images URL 与未落盘的 data URL。
    JPEG 按 EXIF 方向校正，保证与浏览器显示方向一致。
    """
    try:
        from PIL import Image, ImageOps

        if url.startswith("data:image/"):
            _, _, b64 = url.partition(",")
            source = io.BytesIO(base64.b64decode(b64))
        elif is_local_image_url(url):
            rel = _rel_from_url(url)
            source = IMAGES_DIR / rel
        else:
            return None

        with Image.open(source) as im:
            oriented = ImageOps.exif_transpose(im)
            real_w, real_h = int(oriented.width), int(oriented.height)
        if real_w <= 0 or real_h <= 0:
            return None
        scale = max_edge / max(real_w, real_h)
        return max(1, round(real_w * scale)), max(1, round(real_h * scale))
    except (ValueError, OSError, ImportError) as e:
        # 不记录 data URL 本体（可能整段 base64），只记录异常原因
        logger.warning("图片宽高解析失败（URL 类型: %s）: %s", url[:32], e)
        return None


def normalize_state_image_sizes(
    state: CanvasState,
    cache: dict[str, tuple[int, int]] | None = None,
) -> int:
    """把图片节点修正为真实宽高比，返回修正数量。

    cache 使同一图片只解析一次；后续 GET/撤销只做常数时间比对。
    """
    changed = 0
    for node in state.nodes.values():
        url = node.image_url
        if node.type != "image" or not url:
            continue
        expected = cache.get(url) if cache is not None else None
        if expected is None:
            expected = image_display_size(url)
            if expected is not None and cache is not None:
                cache[url] = expected
        if expected is None:
            continue
        width, height = expected
        if node.width != width or node.height != height:
            node.width = width
            node.height = height
            changed += 1
    return changed


def materialize_state_images(state: CanvasState) -> int:
    """把画布内 data URL 节点图片落盘为文件（原地替换为 http URL），返回转换数（幂等）

    落盘到该画布的子目录 images/{canvas_id}/，随画布归类管理。
    """
    count = 0
    for node in state.nodes.values():
        url = node.image_url
        if url and url.startswith("data:image/"):
            try:
                node.image_url = save_data_image(url, state.canvas_id)
                count += 1
            except (ValueError, OSError) as e:
                # 单张落盘失败保留 data URL，不影响保存画布
                logger.warning("节点图片落盘失败（保留 data URL）: %s", e)
    return count
