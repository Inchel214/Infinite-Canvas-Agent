"""FastAPI 应用入口"""
import hmac
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# 用绝对路径加载 .env，不依赖 cwd（无论从哪个目录启动都能找到）
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

# 日志系统必须先于业务模块导入：deps.py 等在 import 期就可能产生
# 降级/Mock 警告，晚配置会漏掉这些启动期日志
from app.log_config import setup_logging

setup_logging()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.image.files import IMAGES_DIR

logger = logging.getLogger(__name__)


def _configure_threadpool() -> None:
    """增大 anyio 默认线程池：FastAPI 的同步 def 路由全部跑在这里，默认上限 40，
    生图/Agent 这类长耗时端点会长时间占用线程，批量并发时容易排队。

    必须在事件循环内执行（导入期 sniffio 识别不到异步后端），故挂在 lifespan 启动阶段。
    CANVAS_THREADPOOL_SIZE <= 0 表示保持框架默认。
    """
    try:
        from anyio import to_thread

        size = int(os.getenv("CANVAS_THREADPOOL_SIZE", "64"))
        if size > 0:
            to_thread.current_default_thread_limiter().total_tokens = size
            logger.info("线程池容量设置为 %d", size)
    except (ImportError, LookupError, RuntimeError, ValueError) as e:
        logger.warning("线程池容量配置失败（保持默认）: %s", e)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _configure_threadpool()
    yield


app = FastAPI(title="Infinite Canvas Agent", version="0.1.0", lifespan=_lifespan)

# 可选访问令牌：默认关闭（本地单用户工具，后端只监听 127.0.0.1）。
# 设置 CANVAS_AUTH_TOKEN 后，所有 /api 请求必须携带 X-Canvas-Token 或
# Authorization: Bearer <token>；前端通过 VITE_API_TOKEN 注入。图片静态资源
# 不校验——<img> 标签无法附加自定义请求头。
_AUTH_TOKEN = (os.getenv("CANVAS_AUTH_TOKEN", "") or "").strip()


class TokenAuthMiddleware:
    """可选令牌鉴权（纯 ASGI，避免干扰 SSE 流）"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in (scope.get("headers") or [])
        }
        token = headers.get("x-canvas-token", "")
        if not token:
            auth = headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
        if hmac.compare_digest(token, _AUTH_TOKEN):
            await self.app(scope, receive, send)
            return
        await JSONResponse(
            {"detail": "未授权：缺少或错误的访问令牌"}, status_code=401
        )(scope, receive, send)


if _AUTH_TOKEN:
    # 先加鉴权再加 CORS：Starlette 后添加的中间件在外层，401 也能带上 CORS 头
    app.add_middleware(TokenAuthMiddleware)

# CORS 配置：allow_origins=["*"] 与 allow_credentials=True 同时使用是 CORS 规范
# 禁止的组合（任意源可携带凭据访问）。本项目无 cookie/浏览器凭据认证，不需要
# allow_credentials（Starlette CORSMiddleware 默认 True，必须显式设为 False）。
# 需要收紧来源时用 CANVAS_ALLOWED_ORIGINS 传逗号分隔的白名单。
_allow_origins = [
    o.strip()
    for o in os.getenv("CANVAS_ALLOWED_ORIGINS", "*").split(",")
    if o.strip()
] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

# 画布图片静态服务（节点 image_url 指向这里，画布 JSON 只存 URL）
IMAGES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/images", StaticFiles(directory=str(IMAGES_DIR), html=False), name="images")


# 给图片静态资源加上浏览器缓存头，避免每次切画布/刷新都重拉图片。
# 必须用纯 ASGI 中间件而非 @app.middleware("http")（BaseHTTPMiddleware）：
# BaseHTTPMiddleware 包装 StreamingResponse 时会破坏 SSE 流的正常结束帧
# （最后不发送 chunked 终止符就关闭连接），浏览器侧表现为每次请求结束
# 都记 net::ERR_ABORTED，且存在竞态——数据未消费完连接先被掐断时
# reader.read() 直接抛错，聊天面板卡在发送态。纯 ASGI 对非 /images/ 请求
# 完全直通，不碰 SSE。
class CacheImagesMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/images/"):
            await self.app(scope, receive, send)
            return

        async def send_with_cache(message):
            # 只在响应头帧补 Cache-Control，不动 body 帧与结束帧
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                lower = {k.lower() for k, _ in headers}
                if b"cache-control" not in lower:
                    headers.append((b"cache-control", b"public, max-age=86400"))
                # 图片是公开资源，但响应只有带 Origin 请求时才有 CORS 头；
                # 若响应被缓存（1 天）后复用于带 Origin 的 fetch，会因缺少
                # Access-Control-Allow-Origin 被判为跨域失败（缓存污染）。
                # 因此固定补 Vary: Origin，并在缺省时补上通配 CORS 头。
                if b"vary" not in lower:
                    headers.append((b"vary", b"Origin"))
                if b"access-control-allow-origin" not in lower:
                    headers.append((b"access-control-allow-origin", b"*"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_cache)


app.add_middleware(CacheImagesMiddleware)


@app.get("/health", summary="健康检查")
def health():
    return {"status": "ok"}
