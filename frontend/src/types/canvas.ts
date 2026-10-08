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
  name?: string;
  created_at?: number;
  updated_at?: number;
}

// 画布摘要（列表用，GET /api/canvas）
export interface CanvasSummary {
  canvas_id: string;
  name: string;
  node_count: number;
  updated_at: number;
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
