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
  /** 节点编号（画布内唯一递增，删除不回收）：用户与 Agent 用 #N 指代 */
  index?: number | null;
  /** 分组标签（用于分区布局，如"需求"、"设计"、"流程"） */
  group?: string;
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
  /** 进行中生图任务数（后端 tasks 注册表） */
  generating?: number;
  /** 未查看的新生成图片数（红点数字） */
  pending?: number;
}

export interface AgentStep {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  content?: string;
  // 流式过程中的状态：pending=执行中，success=是否成功（结束后回填）
  pending?: boolean;
  success?: boolean;
}

export interface ChatResponse {
  success: boolean;
  message: string;
  canvas: CanvasState;
  steps: AgentStep[];
}

// 对话历史消息（GET /agent/history 返回，user/assistant 文本对）
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
