"""FastAPI 应用入口"""
import os
from pathlib import Path

from dotenv import load_dotenv

# 用绝对路径加载 .env，不依赖 cwd（无论从哪个目录启动都能找到）
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

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

# 给图片静态资源加上浏览器缓存头，避免每次切画布/刷新都重拉图片
@app.middleware("http")
async def cache_images(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/images/"):
        response.headers.setdefault("Cache-Control", "public, max-age=86400")
    return response


@app.get("/health", summary="健康检查")
def health():
    return {"status": "ok"}
