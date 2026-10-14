"""FastAPI 应用入口"""
import os
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
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.image.files import IMAGES_DIR

app = FastAPI(title="Infinite Canvas Agent", version="0.1.0")

# CORS 配置（开发用，后续收紧）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", b"public, max-age=86400"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_cache)


app.add_middleware(CacheImagesMiddleware)


@app.get("/health", summary="健康检查")
def health():
    return {"status": "ok"}
