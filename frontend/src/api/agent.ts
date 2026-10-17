// 后端 API 调用

import type {
  AgentStep,
  CanvasState,
  CanvasSummary,
  ChatMessage,
  ChatResponse,
} from "../types/canvas";

const API_BASE = "http://127.0.0.1:8000/api";

// 直接执行类操作（不走 Agent）的响应
export interface DirectResponse {
  success: boolean;
  message: string;
  canvas: CanvasState;
}

export async function createCanvas(name?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/canvas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || "" }),
  });
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

// Agent SSE 流事件（/agent/chat/stream 逐步推送）
export interface AgentStreamEvent {
  // delta / plan_delta / reasoning_delta 为 token 级文本增量（打字机），其余为节点事件
  type:
    | "start"
    | "plan_delta"
    | "reasoning_delta"
    | "delta"
    | "tool_start"
    | "tool_result"
    | "response"
    | "done";
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  success?: boolean;
  stopped?: boolean;
  message?: string;
  canvas?: CanvasState;
  steps?: AgentStep[];
}

// 流式 Agent 对话：计划/思考/工具过程逐事件回调，最终 done 事件带完整结果
export async function chatWithAgentStream(
  canvasId: string,
  prompt: string,
  onEvent: (evt: AgentStreamEvent) => void
): Promise<void> {
  const res = await fetch(`${API_BASE}/agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canvas_id: canvasId, prompt }),
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
    // SSE 帧以空行分隔；跨 chunk 的半帧留在 buf 里等下一块
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            /* 跳过坏帧 */
          }
        }
      }
    }
  }
}

// 停止当前画布正在执行的 Agent 任务（下一个操作边界生效）
export async function stopAgent(
  canvasId: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/agent/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canvas_id: canvasId }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 获取画布对话历史（后端按画布持久化）
export async function getChatHistory(canvasId: string): Promise<ChatMessage[]> {
  const res = await fetch(
    `${API_BASE}/agent/history?canvas_id=${encodeURIComponent(canvasId)}`
  );
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  return data.messages ?? [];
}

// 清空画布对话历史
export async function clearChatHistory(canvasId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agent/history?canvas_id=${encodeURIComponent(canvasId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`${res.status}`);
}

// ===== 流式生成（SSE，图片容器用）=====

export interface StreamEvents {
  onStart?: (mode: "stream" | "estimated") => void;
  onPreview?: (url: string, progress: number) => void;
  onDone?: (done: { success: boolean; message: string; canvas: CanvasState; node_id?: string }) => void;
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
    experience_ids?: string[];
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

// 批量更新节点（内容/位置/尺寸）
export async function updateNodes(
  canvasId: string,
  updates: Array<{ nodeId: string; content?: string; x?: number; y?: number; width?: number; height?: number }>
): Promise<CanvasState> {
  const res = await fetch(
    `${API_BASE}/canvas/${canvasId}/nodes/update`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    }
  );
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  const data = await res.json();
  return data.canvas;
}

// ===== 直接执行类操作（右键菜单/容器触发，不走 Agent）=====

export async function generateImage(
  canvasId: string,
  prompt: string,
  size = "2K",
  x?: number,
  y?: number,
  experienceIds?: string[]
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size, x, y, experience_ids: experienceIds?.length ? experienceIds : undefined }),
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
  y?: number,
  experienceIds?: string[]
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_ids: nodeIds,
      prompt,
      size,
      x,
      y,
      experience_ids: experienceIds?.length ? experienceIds : undefined,
    }),
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
  y?: number,
  experienceIds?: string[]
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/variate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: nodeId,
      prompt,
      size,
      x,
      y,
      experience_ids: experienceIds?.length ? experienceIds : undefined,
    }),
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
  size = "2K",
  x?: number,
  y?: number,
  experienceIds?: string[]
): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: nodeId,
      prompt,
      size,
      x,
      y,
      experience_ids: experienceIds?.length ? experienceIds : undefined,
    }),
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

// 批量移动节点（多选整组拖拽，单次撤销点）
export async function moveNodes(
  canvasId: string,
  moves: { nodeId: string; x: number; y: number }[]
): Promise<CanvasState> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/nodes/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      moves: moves.map((m) => ({ node_id: m.nodeId, x: m.x, y: m.y })),
    }),
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  const data = await res.json();
  return data.canvas;
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

// 重做最近一次撤销，无可重做时后端返回 success:false
export async function redoCanvas(canvasId: string): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/redo`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// 自动整理：网格对齐所有图片
export async function arrangeCanvas(canvasId: string): Promise<DirectResponse> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}/arrange`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  return res.json();
}

// ===== 多画布管理 =====

export async function listCanvases(): Promise<CanvasSummary[]> {
  const res = await fetch(`${API_BASE}/canvas`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// 清除画布未读红点（切换到该画布 = 打开会话）
export async function markCanvasSeen(canvasId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/canvas/${canvasId}/seen`, { method: "POST" });
  } catch {
    // 静默失败：红点下次轮询自然刷新
  }
}

export async function renameCanvas(
  canvasId: string,
  name: string
): Promise<{ success: boolean; message: string; name: string }> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

export async function deleteCanvas(
  canvasId: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/canvas/${canvasId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

// ===== 图片文件定位 =====

// 调后端在系统文件管理器中打开图片所在文件夹（Windows 高亮选中该文件）
export async function revealImageFile(
  url: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/reveal-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

// ===== 大模型服务商设置 =====

export interface LLMSettings {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
}

export interface ImageSettings {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  stream_model: string;
}

// mode: "user"（用户设置）/ "env"（.env 回退）/ "mock"
export interface SettingsStatus {
  mode: "user" | "env" | "mock";
  provider: string;
  model: string;
}

export interface AppSettingsData {
  llm: LLMSettings;
  image: ImageSettings;
  status: { llm: SettingsStatus; image: SettingsStatus };
}

export interface SettingsPayload {
  llm: LLMSettings;
  image: ImageSettings;
}

export interface ProviderPreset {
  name: string;
  base_url: string;
  llm_api: string;
  llm_model: string;
  image_api: string | null;
  image_model: string;
  stream_model: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export async function getSettings(): Promise<AppSettingsData> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function saveSettings(
  payload: SettingsPayload
): Promise<{ success: boolean; message: string; settings: AppSettingsData }> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

export async function resetSettings(): Promise<{
  success: boolean;
  message: string;
  settings: AppSettingsData;
}> {
  const res = await fetch(`${API_BASE}/settings`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function getProviders(): Promise<{
  providers: Record<string, ProviderPreset>;
}> {
  const res = await fetch(`${API_BASE}/providers`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function testSettings(
  payload: SettingsPayload
): Promise<{ llm: TestResult; image: TestResult }> {
  const res = await fetch(`${API_BASE}/settings/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

// ===== 模型名称查询：选完服务商后拉取可用模型列表，供下拉选择 =====

export interface ModelsQueryResult {
  models: string[];
  source: "api" | "preset" | "none"; // api=接口查询 preset=内置列表(Ark) none=不支持
  message?: string;
}

export async function listModels(payload: {
  kind: "llm" | "image";
  provider: string;
  api_key: string;
  base_url: string;
}): Promise<ModelsQueryResult> {
  const res = await fetch(`${API_BASE}/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `${res.status}` }));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

// ===== 风格库（经验文档）：设计师沉淀的风格指南，生图时确定性拼接 =====

export interface ExperienceMeta {
  id: string;
  name: string;
  description: string;
}

// 列出风格（后端每次热扫描目录，手动放文件也生效）
export async function listExperiences(): Promise<ExperienceMeta[]> {
  const res = await fetch(`${API_BASE}/experiences`);
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
  const data = await res.json();
  return data.experiences;
}

// 导入风格 MD（name/description/正文），立即生效
export async function addExperience(
  name: string,
  description: string,
  content: string
): Promise<ExperienceMeta> {
  const res = await fetch(`${API_BASE}/experiences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, content }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `${res.status}`);
  }
  const data = await res.json();
  return data.experience;
}

// 编辑风格名称/描述（不改正文）
export async function updateExperience(
  id: string,
  patch: { name?: string; description?: string }
): Promise<ExperienceMeta> {
  const res = await fetch(`${API_BASE}/experiences/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `${res.status}`);
  }
  const data = await res.json();
  return data.experience;
}

// 删除风格
export async function deleteExperience(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/experiences/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`${res.status}`);
  }
}
