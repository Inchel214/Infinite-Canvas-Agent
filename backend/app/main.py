"""FastAPI 应用入口"""
from dotenv import load_dotenv

load_dotenv()  # 加载 .env 文件中的 API Key

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
