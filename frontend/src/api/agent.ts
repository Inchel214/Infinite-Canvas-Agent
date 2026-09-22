// 后端 API 调用

import type { CanvasState, ChatResponse } from "../types/canvas";

const API_BASE = "http://127.0.0.1:8000/api";

// 直接执行类操作（不走 Agent）的响应
export interface DirectResponse {
  success: boolean;
  message: string;
  canvas: CanvasState;
}

export async function createCanvas(): Promise<string> {
  const res = await fetch(`${API_BASE}/canvas`, { method: "POST" });
  const data = await res.json();
  return data.canvas_id;
}

export async function getCanvas(canvasId: string): Promise<CanvasState> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}`);
  return res.json();
}

export async function chatWithAgent(
  canvasId: string,
  prompt: string
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canvas_id: canvasId, prompt }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// ===== 流式生成（SSE，图片容器用）=====

export interface StreamEvents {
  onStart?: (mode: "stream" | "estimated") => void;
  onPreview?: (url: string, progress: number) => void;
  onDone?: (done: { success: boolean; message: string; canvas: CanvasState }) => void;
}

export async function generateImageStream(
  canvasId: string,
  body: {
    op: "generate" | "variate" | "compose";
    prompt: string;
    size: string;
    x: number;
    y: number;
    node_id?: string;
    node_ids?: string[];
  },
  handlers: StreamEvents
): Promise<void> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/generate_stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "start") handlers.onStart?.(evt.mode);
        else if (evt.type === "preview") handlers.onPreview?.(evt.url, evt.progress);
        else if (evt.type === "done") handlers.onDone?.(evt);
      } catch {
        // 忽略解析失败的行
      }
    }
  }
}

export async function updateNodePosition(
  canvasId: string,
  nodeId: string,
  x: number,
  y: number
): Promise<CanvasState> {
  const res = await fetch(
    `${API_BASE}/canvas/${canvasId}/node/${nodeId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    }
  );
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// ===== 直接执行类操作（右键菜单/容器触发，不走 Agent）=====

export async function generateImage(
  canvasId: string,
  prompt: string,
  size = "2K",
  x?: number,
  y?: number
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size, x, y }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function composeImages(
  canvasId: string,
  nodeIds: string[],
  prompt = "",
  size = "2K",
  x?: number,
  y?: number
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids: nodeIds, prompt, size, x, y }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function variateImage(
  canvasId: string,
  nodeId: string,
  prompt = "",
  size = "2K",
  x?: number,
  y?: number
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/variate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, prompt, size, x, y }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function editImage(
  canvasId: string,
  nodeId: string,
  prompt: string,
  size = "2K"
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, prompt, size }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 上传本地图片（拖拽/粘贴）为画布节点
export async function uploadImageNode(
  canvasId: string,
  body: { image_url: string; x: number; y: number; width: number; height: number }
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/upload_image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 克隆节点（画布内复制粘贴，复制完整属性含提示词）
export async function cloneNode(
  canvasId: string,
  body: {
    image_url: string;
    x: number;
    y: number;
    width: number;
    height: number;
    content: string;
    source_ids: string[];
  }
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/nodes/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

export async function deleteNode(
  canvasId: string,
  nodeId: string
): Promise<DirectResponse> {
  const res = await fetch(
    `${API_BASE}/canvas/${canvasId}/node/${nodeId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 批量删除节点（单次撤销点，一次性恢复全部）
export async function deleteNodes(
  canvasId: string,
  nodeIds: string[]
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/nodes/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids: nodeIds }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 撤销最近一次操作，无历史可撤销时后端返回 success:false
export async function undoCanvas(canvasId: string): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/undo`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}
