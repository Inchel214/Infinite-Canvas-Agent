"""FastAPI 应用入口"""
import os
from pathlib import Path

from dotenv import load_dotenv

# 用绝对路径加载 .env，不依赖 cwd（无论从哪个目录启动都能找到）
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router

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


@app.get("/health", summary="健康检查")
def health():
    return {"status": "ok"}
