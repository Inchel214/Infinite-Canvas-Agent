"""风格库（经验文档）：设计师沉淀的风格指南，供生图 prompt 拼接与 Agent 按需读取。

存储形态：backend/data/experiences/ 下的 MD 文件 + registry.json 注册表。
热加载：每次列表/读取都重扫目录——手动放文件进文件夹或 UI 导入后立即生效，无需重启。
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path

# 风格库目录（backend/data/experiences/）
EXP_DIR = Path(__file__).resolve().parent.parent / "data" / "experiences"
REGISTRY_FILE = EXP_DIR / "registry.json"

_lock = threading.Lock()

# 手动放文件时自动摘取正文前 N 字符作为描述
_AUTO_DESC_LEN = 100


def _ensure_dir() -> None:
    EXP_DIR.mkdir(parents=True, exist_ok=True)


def _load_registry() -> dict:
    """读注册表：{id: {name, description, file}}"""
    if not REGISTRY_FILE.exists():
        return {}
    try:
        return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_registry(reg: dict) -> None:
    REGISTRY_FILE.write_text(
        json.dumps(reg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _extract_desc(content: str) -> str:
    """从正文自动摘取描述：去 markdown 符号与空白，取前 100 字"""
    text = re.sub(r"[#*`>\-\[\]()!_~|]+", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:_AUTO_DESC_LEN] + ("…" if len(text) > _AUTO_DESC_LEN else "")


def _safe_filename(name: str) -> str:
    """文件名安全化：去非法字符，限长"""
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "-", name).strip("-")
    return (cleaned or "style")[:50]


def list_experiences() -> list[dict]:
    """列出全部风格（热加载：每次重扫目录同步注册表）。"""
    with _lock:
        _ensure_dir()
        reg = _load_registry()

        # 文件 → id 映射，用于清理已删除文件
        file_to_id = {v["file"]: k for k, v in reg.items()}

        # 扫描目录：新文件自动注册（name=文件名，description=正文摘要）
        for f in sorted(EXP_DIR.glob("*.md")):
            if f.name in file_to_id:
                continue
            exp_id = uuid.uuid4().hex[:12]
            try:
                content = f.read_text(encoding="utf-8")
            except Exception:
                continue
            reg[exp_id] = {
                "name": f.stem,
                "description": _extract_desc(content),
                "file": f.name,
            }

        # 清理注册表里文件已不存在的条目
        reg = {
            k: v
            for k, v in reg.items()
            if (EXP_DIR / v["file"]).exists()
        }

        _save_registry(reg)
        return [
            {"id": k, "name": v["name"], "description": v["description"]}
            for k, v in reg.items()
        ]


def read_experience(exp_id: str) -> dict | None:
    """读取风格全文：{id, name, description, content}，不存在返回 None"""
    with _lock:
        reg = _load_registry()
        meta = reg.get(exp_id)
        if not meta:
            return None
        path = EXP_DIR / meta["file"]
        if not path.exists():
            return None
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:
            return None
        return {
            "id": exp_id,
            "name": meta["name"],
            "description": meta["description"],
            "content": content,
        }


def add_experience(name: str, description: str, content: str) -> dict:
    """导入新风格：写 MD 文件 + 登记注册表，立即生效"""
    if not name.strip():
        raise ValueError("风格名称不能为空")
    if not content.strip():
        raise ValueError("风格内容不能为空")
    with _lock:
        _ensure_dir()
        reg = _load_registry()
        exp_id = uuid.uuid4().hex[:12]
        filename = f"{_safe_filename(name)}-{exp_id}.md"
        (EXP_DIR / filename).write_text(content, encoding="utf-8")
        reg[exp_id] = {
            "name": name.strip(),
            "description": (description or _extract_desc(content)).strip(),
            "file": filename,
        }
        _save_registry(reg)
        return {"id": exp_id, "name": name.strip(), "description": reg[exp_id]["description"]}


def update_experience(exp_id: str, name: str | None = None, description: str | None = None) -> dict | None:
    """编辑风格的名称/描述（不改正文）"""
    with _lock:
        reg = _load_registry()
        meta = reg.get(exp_id)
        if not meta:
            return None
        if name is not None and name.strip():
            meta["name"] = name.strip()
        if description is not None:
            meta["description"] = description.strip()
        _save_registry(reg)
        return {"id": exp_id, "name": meta["name"], "description": meta["description"]}


def delete_experience(exp_id: str) -> bool:
    """删除风格：删文件 + 移出注册表"""
    with _lock:
        reg = _load_registry()
        meta = reg.pop(exp_id, None)
        if not meta:
            return False
        path = EXP_DIR / meta["file"]
        if path.exists():
            path.unlink()
        _save_registry(reg)
        return True


def get_name(exp_id: str) -> str | None:
    """快速查风格名（用于占位框提示等轻量场景）"""
    reg = _load_registry()
    meta = reg.get(exp_id)
    return meta["name"] if meta else None


def apply_experience(exp_id: str, prompt: str) -> str:
    """把风格全文确定性拼接进用户 prompt（直连生图路径，不经 LLM）"""
    exp = read_experience(exp_id)
    if not exp:
        return prompt
    style_block = f"请严格遵循以下风格指南《{exp['name']}》进行创作：\n{exp['content']}"
    if not prompt.strip():
        return style_block
    return f"{prompt.strip()}\n\n{style_block}"


def catalog_text() -> str:
    """Agent System Prompt 用：风格库目录（仅 id/名称/描述，全文靠 read_experience 按需读）"""
    items = list_experiences()
    if not items:
        return ""
    lines = [f"- {it['id']}:《{it['name']}》{it['description']}" for it in items]
    return "\n".join(lines)
