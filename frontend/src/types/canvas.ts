// 画布相关类型定义

export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  image_url?: string;
  source_ids?: string[];
}

export interface CanvasState {
  canvas_id: string;
  nodes: Record<string, CanvasNode>;
  version: number;
}

export interface AgentStep {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  content?: string;
}

export interface ChatResponse {
  success: boolean;
  message: string;
  canvas: CanvasState;
  steps: AgentStep[];
}
