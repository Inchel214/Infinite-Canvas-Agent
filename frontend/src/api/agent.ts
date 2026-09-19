// 后端 API 调用

import type { CanvasState, ChatResponse } from "../types/canvas";

const API_BASE = "http://localhost:8000/api";

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
