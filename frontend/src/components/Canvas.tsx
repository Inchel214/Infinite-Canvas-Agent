import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasState, CanvasNode } from "../types/canvas";
import { generateImageStream, uploadImageNode, cloneNode, undoCanvas, listExperiences, revealImageFile, type ExperienceMeta } from "../api/agent";

// 右键菜单可触发的操作类型（experienceIds：风格库多选的风格，直连生图时后端确定性拼接）
export type CanvasAction =
  | { type: "compose"; nodeIds: string[]; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[] }
  | { type: "variate"; nodeId: string; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[] }
  | { type: "edit"; nodeId: string; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[] }
  | { type: "generate"; prompt: string; size: string; x: number; y: number; experienceIds?: string[] }
  | { type: "delete"; nodeIds: string[] }
  | { type: "arrange" };

// 待生成图片容器（右键空白创建，接收连线作为参考图）
export type PendingContainer = {
  id: string;
  x: number;            // 世界坐标（左上角）
  y: number;
  w: number;            // 世界宽（创建时按 1/zoom 换算，屏幕上恒为基准大小）
  h: number;            // 世界高
  aspect: string;
  resolution: string;
  prompt: string;
  refIds: string[];     // 连线进来的参考图节点 ID
  experienceIds?: string[]; // 风格库多选的风格
  error?: string;       // 生成失败提示
  previewUrl?: string;  // 流式生成的中间预览图
  exiting?: boolean;    // 生成完成后正在退场（淡出中）
};

// 宽高比预设（长边 = 分辨率档位）
const ASPECT_RATIOS = [
  { key: "1:1", w: 1, h: 1 },
  { key: "4:3", w: 4, h: 3 },
  { key: "3:4", w: 3, h: 4 },
  { key: "16:9", w: 16, h: 9 },
  { key: "9:16", w: 9, h: 16 },
] as const;

const RESOLUTIONS = ["1K", "2K", "4K"] as const;

// 按节点当前宽高比找最接近的预设（编辑图片时默认继承原图比例）
function closestAspectKey(w: number, h: number): string {
  const target = w / h;
  let best: (typeof ASPECT_RATIOS)[number] = ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const diff = Math.abs(r.w / r.h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best.key;
}

// 按图片像素长边找最接近的分辨率档位（编辑图片时默认继承原图分辨率）
function closestResolutionKey(longEdge: number): string {
  const tiers: [string, number][] = [
    ["1K", 1024],
    ["2K", 2048],
    ["4K", 4096],
  ];
  let best = "2K";
  let bestDiff = Infinity;
  for (const [key, px] of tiers) {
    const diff = Math.abs(px - longEdge);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}

// 下载前必须拿到完整的图片 Blob。短暂的本地后端抖动会自动重试，
// 且空响应/错误页不会被当成图片写入磁盘。
async function fetchImageBlob(url: string, attempts = 3): Promise<Blob> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: attempt === 0 ? "default" : "reload" });
      if (!response.ok) {
        throw new Error(`图片请求失败 (${response.status})`);
      }
      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error("图片内容为空");
      }
      if (blob.type && !blob.type.startsWith("image/")) {
        throw new Error(`返回内容不是图片 (${blob.type})`);
      }
      return blob;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("图片加载失败");
}

// 容器面板基准尺寸（屏幕像素）：创建时按 1/zoom 换算为世界尺寸——
// 任何相机视野下创建，屏幕上都呈现同样大小、字体同样清晰；
// 创建后作为画布元素与图片同律缩放（固定在画布坐标上，无相对运动）
const CONTAINER_BASE_W = 340; // 控件（比例按钮一行 5 个）所需宽度
const CONTAINER_BASE_H = 600; // 控件自然高度（实测 598：17px 字号 + 描述框 minHeight 232 的固定行高总和）；基准须≥自然高度，否则可视边框超出世界盒/拉伸柄错位

// 按比例 + 分辨率档位计算 size 字符串（如 "2048x1152"）
function calcSize(ratioKey: string, res: string): string {
  const ratio = ASPECT_RATIOS.find((r) => r.key === ratioKey) ?? ASPECT_RATIOS[0];
  const long = res === "1K" ? 1024 : res === "4K" ? 4096 : 2048;
  let w = ratio.w >= ratio.h ? long : Math.round((long * ratio.w) / ratio.h);
  let h = ratio.w >= ratio.h ? Math.round((long * ratio.h) / ratio.w) : long;
  // Seedream 要求 512~4096 且为 32 的倍数
  w = Math.max(512, Math.min(4096, Math.round(w / 32) * 32));
  h = Math.max(512, Math.min(4096, Math.round(h / 32) * 32));
  // 模型总像素下限 921600（≈960x960，实测 4.0/5.0 Pro）：不足时等比放大（32 倍数对齐），
  // 保证 UI 计算的尺寸与后端实际发送、图片真实输出一致（如 1K 16:9 → 1280x736）
  const MIN_AREA = 921600;
  if (w * h < MIN_AREA) {
    const s = Math.sqrt(MIN_AREA / (w * h));
    w = Math.max(32, Math.ceil((w * s) / 32) * 32);
    h = Math.max(32, Math.ceil((h * s) / 32) * 32);
  }
  return `${w}x${h}`;
}

// 矩形（节点或容器）的边界框
type BBox = { x: number; y: number; width: number; height: number };

// ===== 生成位置避让：避开已有图片与连线 =====

// 所有连线段（源图中心 → 目标图中心）
function segmentsOf(nodes: CanvasNode[]): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = [];
  for (const n of nodes) {
    if (!n.source_ids) continue;
    for (const sid of n.source_ids) {
      const s = nodes.find((m) => m.id === sid);
      if (s) {
        segs.push([
          s.x + s.width / 2,
          s.y + s.height / 2,
          n.x + n.width / 2,
          n.y + n.height / 2,
        ]);
      }
    }
  }
  return segs;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// 线段是否穿过矩形（端点在内 或 与任一边相交）
function segHitsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  if (rx <= x1 && x1 <= rx + rw && ry <= y1 && y1 <= ry + rh) return true;
  if (rx <= x2 && x2 <= rx + rw && ry <= y2 && y2 <= ry + rh) return true;
  const segCross = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
  ) => {
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);
    if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return true; // 共线保守处理
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  };
  const edges: Array<[number, number, number, number]> = [
    [rx, ry, rx + rw, ry],
    [rx, ry + rh, rx + rw, ry + rh],
    [rx, ry, rx, ry + rh],
    [rx + rw, ry, rx + rw, ry + rh],
  ];
  return edges.some((e) => segCross(x1, y1, x2, y2, e[0], e[1], e[2], e[3]));
}

// (x, y) 处放 w×h 是否避开了所有节点（带 padding）和连线
function spotFree(
  nodes: CanvasNode[],
  segs: Array<[number, number, number, number]>,
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 24
): boolean {
  const px = x - pad, py = y - pad, pw = w + 2 * pad, ph = h + 2 * pad;
  for (const n of nodes) {
    if (px < n.x + n.width && px + pw > n.x && py < n.y + n.height && py + ph > n.y) {
      return false;
    }
  }
  for (const [x1, y1, x2, y2] of segs) {
    if (segHitsRect(x1, y1, x2, y2, px, py, pw, ph)) return false;
  }
  return true;
}

/**
 * 根据源节点和目标节点的相对位置，自动选择最佳连接端口，
 * 并返回贝塞尔曲线的起点、终点和两个控制点。
 *
 * 规则：比较两节点中心连线的 dx/dy，取绝对值较大的轴为主轴：
 *   - 水平主轴：源右→目标左（目标在右）或 源左→目标右（目标在左）
 *   - 垂直主轴：源下→目标上（目标在下）或 源上→目标下（目标在上）
 * 控制点沿主轴方向延伸，保证曲线自然不回折。
 */
function getConnectionEndpoints(src: BBox, tgt: BBox) {
  const srcCx = src.x + src.width / 2;
  const srcCy = src.y + src.height / 2;
  const tgtCx = tgt.x + tgt.width / 2;
  const tgtCy = tgt.y + tgt.height / 2;

  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;

  const horizontal = Math.abs(dx) >= Math.abs(dy);

  let x1: number, y1: number, x2: number, y2: number;
  let cx1: number, cy1: number, cx2: number, cy2: number;

  if (horizontal) {
    if (dx >= 0) {
      // 目标在右侧：源右边 → 目标左边
      x1 = src.x + src.width;
      y1 = srcCy;
      x2 = tgt.x;
      y2 = tgtCy;
    } else {
      // 目标在左侧：源左边 → 目标右边
      x1 = src.x;
      y1 = srcCy;
      x2 = tgt.x + tgt.width;
      y2 = tgtCy;
    }
    // offset 不超过端点水平距离的一半：图靠得近时曲线保持单弧，不产生 S 形
    const offset = Math.min(Math.max(40, Math.abs(dx) / 2), Math.max(12, Math.abs(x2 - x1) / 2));
    const dir = dx >= 0 ? 1 : -1;
    cx1 = x1 + dir * offset;
    cy1 = y1;
    cx2 = x2 - dir * offset;
    cy2 = y2;
  } else {
    if (dy >= 0) {
      // 目标在下：源下边 → 目标上边
      x1 = srcCx;
      y1 = src.y + src.height;
      x2 = tgtCx;
      y2 = tgt.y;
    } else {
      // 目标在上：源上边 → 目标下边
      x1 = srcCx;
      y1 = src.y;
      x2 = tgtCx;
      y2 = tgt.y + tgt.height;
    }
    const offset = Math.min(Math.max(40, Math.abs(dy) / 2), Math.max(12, Math.abs(y2 - y1) / 2));
    const dir = dy >= 0 ? 1 : -1;
    cx1 = x1;
    cy1 = y1 + dir * offset;
    cx2 = x2;
    cy2 = y2 - dir * offset;
  }

  return { x1, y1, x2, y2, cx1, cy1, cx2, cy2 };
}

type MenuState = {
  x: number;
  y: number;
  mode: "menu" | "compose" | "variate" | "background";
};

// 编辑图片框：独立于右键菜单，可与之并存
// 连线在画布 SVG 层（世界坐标系）渲染，与图片间连线同风格
type EditPanelState = {
  nodeId: string;   // 被编辑的图片节点
  x: number;         // 屏幕坐标（fixed 定位）
  y: number;
  prompt: string;
  aspect: string;
  resolution: string;
  experienceIds?: string[]; // 风格库多选的风格
};

interface CanvasProps {
  canvasState: CanvasState | null;
  canvasId: string | null;
  busy?: boolean;
  onNodeMoved?: (nodeId: string, x: number, y: number) => void;
  // 多选整组拖拽结束：一次性提交所有节点的新位置（后端单次保存 = 单次撤销）
  onNodesMoved?: (moves: { nodeId: string; x: number; y: number }[]) => void;
  onAction?: (action: CanvasAction) => boolean | void | Promise<boolean | void>;
  onCanvasUpdate?: (state: CanvasState) => void;
  // 右键"添加到对话"：把选中图片引用进 ChatPanel，发送时注入 Agent 上下文
  onAddToChat?: (nodeIds: string[]) => void;
  // 右侧对话面板展开时占据的宽度（含定位边距前的面板净宽）；用于缩放指示器避让
  chatDockWidth?: number;
}

/**
 * 轻量无限画布：零依赖，CSS transform 实现 pan/zoom
 * 支持：滚轮缩放、拖拽平移、图片拖拽移动、自动适配（可开关）
 * 多选：单击/Ctrl+Shift+点选、空白直接拖动框选、右键菜单直接生成
 * 平移：空格+拖动 / Shift+拖动 / 鼠标中键拖动
 */
export function Canvas({ canvasState, canvasId, busy, onNodeMoved, onNodesMoved, onAction, onCanvasUpdate, onAddToChat, chatDockWidth = 0 }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 相机视角存档：每个画布记住用户上次停留的视角（localStorage），切回/刷新时还原。
  // 否则切画布时组件重挂载、视角重置到世界原点——内容不在原点附近时就表现为"画布空白不显示"
  const camKey = canvasId ? `ica:cam:${canvasId}` : null;
  const savedCam = useRef<{ x: number; y: number; z: number } | null>(null);
  if (savedCam.current === null && camKey) {
    try {
      const raw = localStorage.getItem(camKey);
      if (raw) {
        const c = JSON.parse(raw) as { x?: number; y?: number; z?: number };
        if (Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) && (c.z as number) > 0) {
          savedCam.current = { x: c.x as number, y: c.y as number, z: c.z as number };
        }
      }
    } catch {
      // 存档损坏时忽略，退回默认视角
    }
  }
  const [pan, setPan] = useState(savedCam.current ? { x: savedCam.current.x, y: savedCam.current.y } : { x: 0, y: 0 });
  const [zoom, setZoom] = useState(savedCam.current ? savedCam.current.z : 0.5);
  // pan/zoom 的 ref 镜像：原生 wheel 监听里读最新值，避免闭包过期
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // 视角变化即持久化（pan 拖拽已 rAF 合帧，写入频率可控）
  useEffect(() => {
    if (!camKey) return;
    try {
      localStorage.setItem(camKey, JSON.stringify({ x: pan.x, y: pan.y, z: zoom }));
    } catch {
      // 隐私模式等写入失败时忽略，仅本次会话生效
    }
  }, [camKey, pan, zoom]);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const prevNodeCount = useRef(0);

  // 自动适配相机视角开关：节点增减时是否自动缩放/居中（默认开启，偏好持久化）
  const [autoFit, setAutoFit] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ica-auto-fit") !== "0";
    } catch {
      return true;
    }
  });
  const toggleAutoFit = useCallback(() => {
    setAutoFit((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ica-auto-fit", next ? "1" : "0");
      } catch {
        // 隐私模式等写入异常时忽略，仅本次会话生效
      }
      return next;
    });
  }, []);

  // 拖拽图片相关状态
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  // 本地位置覆盖（拖拽时即时更新，不等待 API）
  const [localOverrides, setLocalOverrides] = useState<Record<string, { x: number; y: number }>>({});
  // 多选整组拖拽：按下多选集合内的图时，记录所有选中节点的原始位置 + 鼠标世界坐标起点
  const dragGroupOriginsRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const dragGroupStartRef = useRef<{ x: number; y: number } | null>(null);

  // ===== 多选 / 框选 / 右键菜单 =====
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [promptInput, setPromptInput] = useState("");
  // 尺寸选择（宽高比 + 分辨率档位）
  const [aspect, setAspect] = useState<string>("1:1");
  const [resolution, setResolution] = useState<string>("2K");

  // ===== 风格库（经验文档）：直连生图面板可选风格，后端确定性拼接 =====
  const [experiences, setExperiences] = useState<ExperienceMeta[]>([]);
  const [menuStyleIds, setMenuStyleIds] = useState<string[]>([]); // 右键菜单 compose/variate 输入面板多选
  const refreshExperiences = useCallback(() => {
    listExperiences()
      .then((list) => setExperiences(list))
      .catch(() => {
        // 后端不可用时静默忽略（风格下拉退化为"无"）
      });
  }, []);
  // 挂载时 + 每次打开右键菜单时刷新（设置面板导入新风格后立即可选）
  useEffect(() => {
    refreshExperiences();
  }, [refreshExperiences]);
  useEffect(() => {
    if (menu) refreshExperiences();
  }, [menu, refreshExperiences]);
  // 风格名查找（占位框提示用）：多选时名称以"、"连接，超过 2 个省略为"等 N 个"
  const styleNamesByIds = useCallback(
    (ids: string[] | undefined) => {
      if (!ids || ids.length === 0) return undefined;
      const names = ids
        .map((id) => experiences.find((e) => e.id === id)?.name)
        .filter((n): n is string => !!n);
      if (names.length === 0) return undefined;
      if (names.length <= 2) return names.join("、");
      return `${names.slice(0, 2).join("、")} 等 ${names.length} 个`;
    },
    [experiences]
  );

  // ===== 编辑图片框（独立于右键菜单，可与普通菜单并存） =====
  const [editPanel, setEditPanel] = useState<EditPanelState | null>(null);
  const editPanelRef = useRef<HTMLDivElement>(null);
  // 生成中占位框：编辑/变体/组合执行时，在新图将要出现的位置预先画出矩形框，
  // 框内显示"正在编辑图片..."等状态；完成后新图淡入该位置。
  // 数组形式支持多张图同时编辑：每个操作绑定自己的占位框，完成时只移除自己的
  const [processingBoxes, setProcessingBoxes] = useState<
    { id: number; x: number; y: number; w: number; h: number; label: string }[]
  >([]);
  const processingSeqRef = useRef(0);
  // 添加占位框（返回 id），操作结束时用 removeProcessingBox(id) 只清掉自己
  const addProcessingBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }, label: string) => {
      const id = ++processingSeqRef.current;
      setProcessingBoxes((prev) => [...prev, { ...box, id, label }]);
      return id;
    },
    []
  );
  const removeProcessingBox = useCallback((id: number) => {
    setProcessingBoxes((prev) => prev.filter((b) => b.id !== id));
  }, []);
  // 编辑框真实屏幕矩形（屏幕层锚定连线终点；位置/尺寸变化时驱动连线重渲染）
  const [editPanelRect, setEditPanelRect] = useState({ x: 0, y: 0, w: 340, h: 420 });

  // ===== 待生成图片容器 + 连线 =====
  const [containers, setContainers] = useState<PendingContainer[]>([]);
  const [connecting, setConnecting] = useState<{ fromId: string; x: number; y: number; sx: number; sy: number } | null>(null);
  const [draggingContainer, setDraggingContainer] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [generatingContainerId, setGeneratingContainerId] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState(0);
  // 最近点击（激活）的容器 id：点击容器后按 Esc 直接关闭该容器
  const activeContainerIdRef = useRef<string | null>(null);
  // Esc 处理器（固定依赖的 keydown effect）读最新生成中容器的镜像
  const generatingContainerIdRef = useRef<string | null>(null);
  useEffect(() => {
    generatingContainerIdRef.current = generatingContainerId;
  }, [generatingContainerId]);
  const [localStatusMsg, setLocalStatusMsg] = useState<string | null>(null);
  const containerSeqRef = useRef(0);
  // 画布内复制/粘贴的剪贴板（存节点副本，Ctrl+V 粘贴到画布）
  const clipboardRef = useRef<CanvasNode[] | null>(null);

  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  // 平移 rAF 合帧数据
  const panRafData = useRef<{ raf: number | null; dx: number; dy: number }>({ raf: null, dx: 0, dy: 0 });
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const backgroundDownRef = useRef<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 空格键按下时切换为平移模式（避免破坏现有 Shift 框选习惯）
  const isSpacePressedRef = useRef(false);
  const [spacePressed, setSpacePressed] = useState(false);

  const rawNodes = canvasState ? Object.values(canvasState.nodes) : [];

  // 合并本地覆盖位置
  const nodes = rawNodes.map((n) => {
    const ov = localOverrides[n.id];
    return ov ? { ...n, x: ov.x, y: ov.y } : n;
  });

  // 画布状态变更（拖拽后端回显/自动整理/删除等）后：本地坐标覆盖让位于后端权威数据，
  // 否则自动整理后节点仍停留在拖拽前的旧位置，需刷新页面才能看到新布局
  useEffect(() => {
    setLocalOverrides({});
    setSelectedIds((prev) => {
      const alive = new Set(nodes.map((n) => n.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [canvasState]);

  // Esc：关闭激活容器 / 关闭菜单 / 清空选择 / 取消连线
  // Delete/Backspace：删除选中节点
  // Ctrl+C / Cmd+C：复制选中图片到系统剪贴板（可在文件管理器粘贴为 PNG）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 点击过的容器：Esc 直接关闭（生成中的除外，避免误关丢进度）
        const ac = activeContainerIdRef.current;
        if (ac && ac !== generatingContainerIdRef.current) {
          activeContainerIdRef.current = null;
          setContainers((prev) => prev.filter((c) => c.id !== ac));
        }
        setMenu(null);
        setEditPanel(null);
        setSelectedIds(new Set());
        setConnecting(null);
        return;
      }
      // 输入框聚焦时不拦截快捷键（保留正常打字/复制文本）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      // 空格键：切换平移模式
      if (e.code === "Space") {
        if (!isSpacePressedRef.current) {
          isSpacePressedRef.current = true;
          setSpacePressed(true);
        }
        e.preventDefault();
        return;
      }

      // Ctrl/Cmd+Z → 撤销
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && canvasId) {
        e.preventDefault();
        undoCanvas(canvasId)
          .then((res) => {
            if (res.success) onCanvasUpdate?.(res.canvas);
          })
          .catch(() => {
            // 网络错误静默忽略
          });
        return;
      }

      // Delete / Backspace → 删除选中
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        onAction?.({ type: "delete", nodeIds: [...selectedIds] });
        setMenu(null);
        return;
      }
      // Ctrl+C / Cmd+C → 画布内复制选中图片（存入剪贴板状态）
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && selectedIds.size >= 1) {
        const ids = [...selectedIds];
        const copies = ids
          .map((id) => nodes.find((n) => n.id === id))
          .filter((n): n is CanvasNode => !!n && !!n.image_url);
        if (copies.length > 0) {
          e.preventDefault();
          clipboardRef.current = copies;
          setLocalStatusMsg(`已复制 ${copies.length} 张图片，Ctrl+V 粘贴到画布`);
          setTimeout(() => setLocalStatusMsg(null), 2200);
        }
      }
      // Ctrl+V / Cmd+V → 在当前视图中心粘贴复制的图片到画布
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V") && clipboardRef.current) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          // 世界坐标 = 视图中心
          const cx = (rect.width / 2 - panRef.current.x) / zoomRef.current;
          const cy = (rect.height / 2 - panRef.current.y) / zoomRef.current;
          // 克隆节点：复制完整属性（含提示词 content、来源 source_ids）
          (async () => {
            let ox = 0, oy = 0;
            let okCount = 0;
            let failCount = 0;
            for (const src of clipboardRef.current!) {
              try {
                const res = await cloneNode(canvasId!, {
                  image_url: src.image_url!,
                  x: cx + ox,
                  y: cy + oy,
                  width: src.width,
                  height: src.height,
                  content: src.content ?? "",
                  source_ids: src.source_ids ?? [],
                });
                if (res.success) {
                  onCanvasUpdate?.(res.canvas);
                  okCount++;
                } else {
                  failCount++;
                }
                ox += src.width * 0.3;
                oy += src.height * 0.3;
              } catch {
                failCount++;
              }
            }
            if (failCount === 0) {
              setLocalStatusMsg(`已粘贴 ${okCount} 张图片`);
            } else {
              setLocalStatusMsg(`粘贴 ${okCount} 张成功，${failCount} 张失败（请检查后端）`);
            }
            setTimeout(() => setLocalStatusMsg(null), 2200);
          })();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds, nodes, onAction, canvasId, onCanvasUpdate, setLocalStatusMsg]);

  // 空格键抬起：清除平移模式
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        if (isSpacePressedRef.current) {
          isSpacePressedRef.current = false;
          setSpacePressed(false);
        }
      }
    };
    window.addEventListener("keyup", handler);
    return () => window.removeEventListener("keyup", handler);
  }, []);

  // 屏幕坐标（相对画布容器）→ 世界坐标
  const screenToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom]
  );

  // 创建待生成容器（居中于世界坐标 wx/wy 处，可带初始参考图）：
  // 世界尺寸 = 基准/zoom，任何视野下创建时屏幕上都呈 340×600、字体清晰；
  // 位置尽量钳制在当前相机视野内（仅创建时算一次，之后仍是固定画布元素，与图片同律缩放）
  const createContainer = useCallback((wx: number, wy: number, refId?: string) => {
    containerSeqRef.current += 1;
    const w = Math.round(CONTAINER_BASE_W / zoom);
    const h = Math.round(CONTAINER_BASE_H / zoom);
    let x = Math.round(wx - w / 2);
    let y = Math.round(wy - h / 2);
    // 可视区域（世界坐标）：排除右侧聊天面板与底部工具按钮行
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const chat = document.querySelector<HTMLElement>('[data-role="chat-panel"]');
      const usableR = (chat ? chat.getBoundingClientRect().left - 8 : rect.right - 8) - rect.left;
      const usableB = rect.height - 56; // 底部工具按钮行高约 48px
      const vl = -pan.x / zoom;
      const vt = -pan.y / zoom;
      const vr = (usableR - pan.x) / zoom;
      const vb = (usableB - pan.y) / zoom;
      // 放得下则钳进视野（尽量贴近原点击点）；放不下（窗口过小）则左上角对齐
      x = vr - vl >= w ? Math.min(Math.max(x, vl + 8 / zoom), vr - w) : vl;
      y = vb - vt >= h ? Math.min(Math.max(y, vt + 8 / zoom), vb - h) : vt;
    }
    const c: PendingContainer = {
      id: `pending-${Date.now()}-${containerSeqRef.current}`,
      x,
      y,
      w,
      h,
      aspect: "1:1",
      resolution: "2K",
      prompt: "",
      refIds: refId ? [refId] : [],
    };
    setContainers((prev) => [...prev, c]);
  }, [zoom, pan]);

  const updateContainer = useCallback((id: string, patch: Partial<PendingContainer>) => {
    setContainers((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeContainer = useCallback((id: string) => {
    // 同步清掉激活标记（该容器被 × 删除后 Esc 不应再作用于它）
    if (activeContainerIdRef.current === id) activeContainerIdRef.current = null;
    setContainers((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // ===== 拖拽/粘贴上传本地图片 =====
  const uploadImages = useCallback(
    async (files: File[], wx: number, wy: number) => {
      if (!canvasId) return;
      let ox = 0;
      let oy = 0;
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        try {
          // 读取文件为 data URL
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(new Error("读取文件失败"));
            r.readAsDataURL(file);
          });
          // 获取图片真实宽高
          const dim = await new Promise<{ w: number; h: number }>((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 300, h: 300 });
            img.src = dataUrl;
          });
          // 显示尺寸：最长边 400，与生成图节点一致
          const scale = 400 / Math.max(dim.w, dim.h);
          const w = Math.max(1, Math.round(dim.w * scale));
          const h = Math.max(1, Math.round(dim.h * scale));
          const res = await uploadImageNode(canvasId, {
            image_url: dataUrl,
            x: wx + ox,
            y: wy + oy,
            width: w,
            height: h,
          });
          if (res.success) onCanvasUpdate?.(res.canvas);
          ox += w * 0.3; // 多张图片错开摆放
          oy += h * 0.3;
        } catch {
          // 单张失败跳过，不影响其他
        }
      }
    },
    [canvasId, onCanvasUpdate]
  );

  // 拖拽文件进入/离开（高亮提示）
  const [dragOver, setDragOver] = useState(false);

  // Ctrl+V 粘贴图片（输入框聚焦时让位给正常文本粘贴）
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      // 画布内复制优先：如果 clipboardRef 有内容，让 keydown 处理，跳过系统剪贴板
      if (clipboardRef.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      // 粘贴位置：当前视图中心
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const c = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      uploadImages(files, c.x, c.y);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [uploadImages, screenToWorld]);

  // 从图片边缘连接点开始拖线
  const handlePortMouseDown = useCallback(
    (e: React.MouseEvent, node: CanvasNode, portIdx: number) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      // 与 ImageNode 中 ports 数组保持一致的端口定义
      const portOffsets = [
        { x: node.width / 2, y: 0 },
        { x: node.width, y: node.height / 2 },
        { x: node.width / 2, y: node.height },
        { x: 0, y: node.height / 2 },
      ];
      const p = portOffsets[portIdx] ?? portOffsets[1];
      const sx = node.x + p.x;
      const sy = node.y + p.y;
      setConnecting({ fromId: node.id, x: e.clientX, y: e.clientY, sx, sy });
    },
    []
  );

  // 点击菜单外部关闭（点击编辑框时不关闭菜单，两者可并存）
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      // 点击编辑框内部时不关闭普通菜单
      if (editPanelRef.current && editPanelRef.current.contains(e.target as Node)) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  // 适配全部节点：计算包围盒并缩放居中（自动适配与"回到全图视角"按钮共用）
  const fitAllNodes = useCallback(() => {
    if (nodes.length === 0 || !containerRef.current) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const container = containerRef.current;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const padding = 60;
    const scaleX = (cw - padding * 2) / contentW;
    const scaleY = (ch - padding * 2) / contentH;
    const newZoom = Math.min(scaleX, scaleY, 1);
    setZoom(newZoom);
    setPan({
      x: (cw - contentW * newZoom) / 2 - minX * newZoom,
      y: (ch - contentH * newZoom) / 2 - minY * newZoom,
    });
  }, [nodes]);

  // 首次进入视角：无存档时适配一次全部节点——让"自动适配"关闭的用户
  // 切画布/首次打开也能看到内容（否则视角停在原点，内容不在原点附近=一片空白）
  const didInitialViewRef = useRef(false);
  useEffect(() => {
    if (didInitialViewRef.current || nodes.length === 0) return;
    didInitialViewRef.current = true;
    if (!savedCam.current) fitAllNodes();
  }, [nodes.length, fitAllNodes]);

  // 自动适配：节点数量变化时缩放到合适大小（受 autoFit 开关控制）
  useEffect(() => {
    if (nodes.length === 0) return;
    if (!autoFit) {
      // 关闭期间仅同步计数：重新开启后不会因数量差立刻跳转视角
      prevNodeCount.current = nodes.length;
      return;
    }
    if (nodes.length === prevNodeCount.current) return;
    const firstRun = prevNodeCount.current === 0;
    prevNodeCount.current = nodes.length;
    // 挂载时已还原存档视角：首次计数变化不再自动适配，尊重用户上次停留的视角
    if (firstRun && savedCam.current) return;
    fitAllNodes();
  }, [canvasState, autoFit, fitAllNodes, nodes.length]);

  // 整理等操作完成后待执行的视角适配：须等 canvasState 重渲染出最新节点后再 fit，
  // 否则 fitAllNodes 闭包里是旧坐标，视角跳错位置（表现为"要刷新页面才更新"）
  const pendingFitRef = useRef(false);
  useEffect(() => {
    if (pendingFitRef.current) {
      pendingFitRef.current = false;
      fitAllNodes();
    }
  }, [canvasState, fitAllNodes]);

  // 滚轮缩放：原生非 passive 监听（React onWheel 是 passive，preventDefault 无效）
  // rAF 合帧：同一帧内的多次 wheel 事件合并为一次渲染，避免高频重渲染卡顿
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf: number | null = null;
    let acc = 0; // 帧内 deltaY 累积
    let mx = 0, my = 0; // 最后一次事件的鼠标位置
    const onWheel = (e: WheelEvent) => {
      // 光标位于实际溢出的可滚动元素上（textarea / overflow 滚动区）→ 交给原生滚动，不缩放
      const target = e.target as HTMLElement | null;
      if (target) {
        let el: HTMLElement | null = target;
        while (el && el !== container) {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
            const st = window.getComputedStyle(el);
            if (
              el.tagName === "TEXTAREA" ||
              st.overflowY === "auto" || st.overflowY === "scroll" ||
              st.overflowX === "auto" || st.overflowX === "scroll"
            ) {
              return; // 不 preventDefault，浏览器自己滚
            }
          }
          el = el.parentElement;
        }
        // 光标位于图片容器框内：滚轮操控框内溢出的描述输入框滚动条，而非缩放画布
        const scope = target.closest("[data-scroll-scope]");
        if (scope) {
          const scroller = Array.from(
            scope.querySelectorAll<HTMLElement>("textarea")
          ).find((t) => t.scrollHeight > t.clientHeight + 1);
          if (scroller) {
            const dy =
              e.deltaMode === 1 ? e.deltaY * 16
                : e.deltaMode === 2 ? e.deltaY * scroller.clientHeight
                  : e.deltaY;
            scroller.scrollTop += dy;
            e.preventDefault();
            return;
          }
        }
      }
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      mx = e.clientX - rect.left;
      my = e.clientY - rect.top;
      acc += e.deltaY;
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const delta = -acc * 0.001;
        acc = 0;
        const p = panRef.current;
        const z = zoomRef.current;
        const factor = Math.exp(delta);
        const newZoom = Math.min(Math.max(z * factor, 0.05), 5);
        const worldX = (mx - p.x) / z;
        const worldY = (my - p.y) / z;
        setPan({ x: mx - worldX * newZoom, y: my - worldY * newZoom });
        setZoom(newZoom);
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  // 背景鼠标按下：直接拖=框选，Shift/空格/中键拖=平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 中键拖动 = 平移（任意位置）
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      backgroundDownRef.current = { x: e.clientX, y: e.clientY };
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      return;
    }
    if (e.button !== 0) return;
    // 只在点击背景时启动
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.role === "world") {
      // 点到空白处：容器不再是"激活"状态（Esc 不再关闭它）
      activeContainerIdRef.current = null;
      if (e.shiftKey || isSpacePressedRef.current) {
        // 平移
        setIsPanning(true);
        backgroundDownRef.current = { x: e.clientX, y: e.clientY };
        panStart.current = {
          x: e.clientX,
          y: e.clientY,
          panX: pan.x,
          panY: pan.y,
        };
      } else {
        // 直接拖动 = 框选
        marqueeStartRef.current = { x: e.clientX, y: e.clientY };
        setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
      }
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (connecting) {
      // 连线拖动中：更新鼠标位置
      setConnecting((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : null));
      return;
    }
    if (marqueeStartRef.current) {
      // 框选拖动中
      setMarquee((prev) => (prev ? { ...prev, x2: e.clientX, y2: e.clientY } : null));
      return;
    }
    if (draggingContainer) {
      // 拖拽容器
      const w = screenToWorld(e.clientX, e.clientY);
      setContainers((prev) =>
        prev.map((c) =>
          c.id === draggingContainer.id
            ? { ...c, x: w.x - draggingContainer.offsetX, y: w.y - draggingContainer.offsetY }
            : c
        )
      );
      return;
    }
    if (draggingNode) {
      // 拖拽图片
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldX = (mouseX - pan.x) / zoom;
      const worldY = (mouseY - pan.y) / zoom;
      const groupOrigins = dragGroupOriginsRef.current;
      const groupStart = dragGroupStartRef.current;
      if (groupOrigins && groupStart) {
        // 多选整组拖拽：所有选中节点按相同位移平移，保持相对布局
        const dx = worldX - groupStart.x;
        const dy = worldY - groupStart.y;
        const next: Record<string, { x: number; y: number }> = {};
        for (const [id, orig] of Object.entries(groupOrigins)) {
          next[id] = { x: orig.x + dx, y: orig.y + dy };
        }
        setLocalOverrides((prev) => ({ ...prev, ...next }));
      } else {
        setLocalOverrides((prev) => ({
          ...prev,
          [draggingNode]: {
            x: worldX - dragOffset.x,
            y: worldY - dragOffset.y,
          },
        }));
      }
    } else if (isPanning) {
      // rAF 合帧：一帧内多次 mousemove 合并为一次 setPan，避免高频重渲染
      panRafData.current.dx = e.clientX - panStart.current.x;
      panRafData.current.dy = e.clientY - panStart.current.y;
      if (panRafData.current.raf !== null) return;
      panRafData.current.raf = requestAnimationFrame(() => {
        panRafData.current.raf = null;
        setPan({
          x: panStart.current.panX + panRafData.current.dx,
          y: panStart.current.panY + panRafData.current.dy,
        });
      });
    }
  }, [connecting, draggingContainer, draggingNode, isPanning, pan, zoom, dragOffset, screenToWorld]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // 连线结束：判断是否命中容器（命中范围覆盖容器整个可视区域，世界坐标判定）
    if (connecting) {
      const w = screenToWorld(e.clientX, e.clientY);
      const hit = containers.find(
        (c) =>
          w.x >= c.x &&
          w.x <= c.x + c.w &&
          w.y >= c.y &&
          w.y <= c.y + c.h + 24
      );
      if (hit && !hit.refIds.includes(connecting.fromId)) {
        // 命中容器：添加参考图
        updateContainer(hit.id, { refIds: [...hit.refIds, connecting.fromId], error: undefined });
      } else if (!hit) {
        // 空白处松手：原地新建容器（居中于落点），并自动连上该参考图
        createContainer(w.x, w.y, connecting.fromId);
      }
      setConnecting(null);
      return;
    }

    // 容器拖动结束
    if (draggingContainer) {
      setDraggingContainer(null);
      return;
    }

    // 框选结束：转世界坐标，选中相交节点
    if (marquee) {
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const sx1 = Math.min(marquee.x1, marquee.x2) - rect.left;
        const sy1 = Math.min(marquee.y1, marquee.y2) - rect.top;
        const sx2 = Math.max(marquee.x1, marquee.x2) - rect.left;
        const sy2 = Math.max(marquee.y1, marquee.y2) - rect.top;
        const wx1 = (sx1 - pan.x) / zoom;
        const wy1 = (sy1 - pan.y) / zoom;
        const wx2 = (sx2 - pan.x) / zoom;
        const wy2 = (sy2 - pan.y) / zoom;
        const hits = nodes.filter(
          (n) => n.x < wx2 && n.x + n.width > wx1 && n.y < wy2 && n.y + n.height > wy1
        );
        setSelectedIds(new Set(hits.map((n) => n.id)));
      }
      marqueeStartRef.current = null;
      setMarquee(null);
      return;
    }

    if (draggingNode) {
      const start = dragStartPosRef.current;
      const moved = start
        ? Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) >= 4
        : true;

      if (moved) {
        // 真正的拖拽：通知后端
        const groupOrigins = dragGroupOriginsRef.current;
        if (groupOrigins) {
          // 多选整组拖拽：一次性批量提交（后端单次保存 = 单次撤销）
          const moves: { nodeId: string; x: number; y: number }[] = [];
          for (const id of Object.keys(groupOrigins)) {
            const pos = localOverrides[id];
            if (pos) moves.push({ nodeId: id, x: pos.x, y: pos.y });
          }
          if (moves.length > 0) onNodesMoved?.(moves);
        } else {
          const pos = localOverrides[draggingNode];
          if (pos && onNodeMoved) {
            onNodeMoved(draggingNode, pos.x, pos.y);
          }
        }
        dragGroupOriginsRef.current = null;
        dragGroupStartRef.current = null;
      } else {
        // click（位移 < 4px）：处理选择
        const nodeId = draggingNode;
        if (e.ctrlKey || e.shiftKey) {
          // 加选 / 减选
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(nodeId)) {
              next.delete(nodeId);
            } else {
              next.add(nodeId);
            }
            return next;
          });
        } else {
          setSelectedIds(new Set([nodeId]));
        }
      }
      setDraggingNode(null);
      dragStartPosRef.current = null;
      return;
    }

    if (isPanning) {
      // 空白 click（无位移）：清空选择、关闭普通菜单（编辑框独立保留，只能 Esc 关闭）
      const down = backgroundDownRef.current;
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 4) {
        setSelectedIds(new Set());
        setMenu(null);
      }
      backgroundDownRef.current = null;
      setIsPanning(false);
    }
  }, [marquee, draggingNode, localOverrides, onNodeMoved, onNodesMoved, isPanning, pan, zoom, nodes, connecting, containers, updateContainer, screenToWorld, draggingContainer, createContainer, menu]);

  // 图片节点拖拽开始（记录起点用于 click/drag 判定）
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, node: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    // 点击图片节点：容器不再是"激活"状态（Esc 不再关闭它）
    activeContainerIdRef.current = null;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - pan.x) / zoom;
    const worldY = (mouseY - pan.y) / zoom;

    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
    setDragOffset({
      x: worldX - node.x,
      y: worldY - node.y,
    });
    // 按在多选集合内的图上：整组一起拖（所有选中节点保持相对位置同步平移）
    if (selectedIds.has(node.id) && selectedIds.size > 1) {
      const origs: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (selectedIds.has(n.id)) origs[n.id] = { x: n.x, y: n.y };
      }
      dragGroupOriginsRef.current = origs;
      dragGroupStartRef.current = { x: worldX, y: worldY };
    } else {
      dragGroupOriginsRef.current = null;
      dragGroupStartRef.current = null;
    }
    setDraggingNode(node.id);
  }, [pan, zoom, selectedIds, nodes]);

  // 图片右键：选中（若未选中）并打开普通菜单
  // 编辑框若已打开则保持不变，右键其它图片正常弹出普通菜单（两者并存）
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: CanvasNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds.has(node.id)) {
      setSelectedIds(new Set([node.id]));
    }
    setPromptInput("");
    setMenu({ x: e.clientX, y: e.clientY, mode: "menu" });
  }, [selectedIds]);

  // 菜单操作
  const handleMenuAction = useCallback((mode: "compose" | "variate" | "edit") => {
    // 编辑图片：打开独立编辑框（带连线），默认回填原提示词，与普通菜单分离
    if (mode === "edit" && selectedIds.size === 1) {
      const node = nodes.find((n) => n.id === [...selectedIds][0]);
      const c = node?.content ?? "";
      if (node && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const sx = rect.left + pan.x + node.x * zoom;
        const sy = rect.top + pan.y + node.y * zoom;
        const sw = node.width * zoom;
        const sh = node.height * zoom;
        const PANEL_W = 340;
        const PANEL_H = 440;
        let mx = sx + sw + 28; // 右侧优先
        if (mx + PANEL_W > window.innerWidth - 8) mx = Math.max(8, sx - PANEL_W - 28); // 空间不够放左侧
        const my = Math.max(8, Math.min(sy + sh / 2 - PANEL_H / 2, window.innerHeight - PANEL_H - 8));
        setEditPanel({
          nodeId: node.id,
          x: mx,
          y: my,
          prompt: c && c !== "本地图片" ? c : "",
          // 默认继承节点当前宽高比（就近匹配预设），而不是全局上次选择
          aspect: closestAspectKey(node.width, node.height),
          resolution,
        });
        // 分辨率同样默认继承原图：节点只存世界尺寸（生成图固定 400 长边），
        // 需异步读图片 natural 尺寸后按长边就近匹配档位（图片已展示过，走缓存几乎瞬时）
        if (node.image_url) {
          const nid = node.id;
          const img = new Image();
          img.onload = () => {
            const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
            if (longEdge > 0) {
              setEditPanel((p) =>
                p && p.nodeId === nid ? { ...p, resolution: closestResolutionKey(longEdge) } : p
              );
            }
          };
          img.src = node.image_url;
        }
        setMenu(null); // 关闭普通菜单，编辑框独立显示
        return;
      }
    }
    if (mode === "edit") return; // 编辑仅支持单图独立编辑框，条件不满足时忽略
    setPromptInput("");
    setMenu((prev) => (prev ? { ...prev, mode } : null));
  }, [nodes, selectedIds, pan, zoom, resolution]);

  // 右键"添加到对话"：把当前选中的图片引用进 ChatPanel（去重追加）
  const handleAddToChat = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    onAddToChat?.(ids);
    setMenu(null);
  }, [selectedIds, onAddToChat]);

  // 计算生成中占位框的尺寸/位置：尺寸与最终图节点一致（最长边 400），
  // 位置优先放参考图组右侧（顶部对齐），若该处有图片或连线则依次退让：
  // 源图组下方 → 全部内容最右侧；占位框位置即最终落图位置（随 action 传后端）
  const buildProcessingBox = useCallback((
    aspectKey: string,
    srcNodes: CanvasNode[]
  ): { x: number; y: number; w: number; h: number } => {
    const ratio = ASPECT_RATIOS.find((r) => r.key === aspectKey) ?? ASPECT_RATIOS[0];
    const long = 400; // 与后端 _DISPLAY_MAX 一致，新图出现时无缝衔接
    const w = ratio.w >= ratio.h ? long : Math.round((long * ratio.w) / ratio.h);
    const h = ratio.w >= ratio.h ? Math.round((long * ratio.h) / ratio.w) : long;

    if (nodes.length > 0) {
      const segs = segmentsOf(nodes);
      const gap = 60;
      // 候选1：源图组右侧，顶部对齐
      const rightX = Math.max(...srcNodes.map((n) => n.x + n.width)) + gap;
      const rightY = Math.min(...srcNodes.map((n) => n.y));
      if (spotFree(nodes, segs, rightX, rightY, w, h)) return { x: rightX, y: rightY, w, h };
      // 候选2：源图组下方，左对齐
      const belowY = Math.max(...srcNodes.map((n) => n.y + n.height)) + gap;
      const belowX = Math.min(...srcNodes.map((n) => n.x));
      if (spotFree(nodes, segs, belowX, belowY, w, h)) return { x: belowX, y: belowY, w, h };
      // 候选3：全部内容最右侧（必然无重叠）
      const allX = Math.max(...nodes.map((n) => n.x + n.width)) + gap;
      const allY = Math.min(...nodes.map((n) => n.y));
      return { x: allX, y: allY, w, h };
    }

    // 空画布：源图组（不存在则原点附近）右侧
    const x = Math.max(100, ...srcNodes.map((n) => n.x + n.width)) + 60;
    const y = srcNodes.length > 0 ? Math.min(...srcNodes.map((n) => n.y)) : 100;
    return { x, y, w, h };
  }, [nodes]);

  const handleExecute = useCallback(() => {
    if (!onAction || !menu) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const prompt = promptInput.trim();
    const size = calcSize(aspect, resolution);
    const srcNodes = ids.map((id) => nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n);
    if (srcNodes.length === 0) return;
    const box = buildProcessingBox(aspect, srcNodes);

    if (menu.mode === "compose" && ids.length >= 2) {
      setMenu(null);
      setPromptInput("");
      const sname = styleNamesByIds(menuStyleIds);
      const boxId = addProcessingBox(box, sname ? `正在按《${sname}》组合...` : `正在组合 ${ids.length} 张图片...`);
      Promise.resolve(
        onAction({ type: "compose", nodeIds: ids, prompt, size, x: box.x, y: box.y, experienceIds: menuStyleIds.length ? menuStyleIds : undefined })
      ).finally(() => removeProcessingBox(boxId));
    } else if (menu.mode === "variate" && ids.length === 1) {
      setMenu(null);
      setPromptInput("");
      const sname = styleNamesByIds(menuStyleIds);
      const boxId = addProcessingBox(box, sname ? `正在按《${sname}》生成变体...` : "正在生成变体...");
      Promise.resolve(
        onAction({ type: "variate", nodeId: ids[0], prompt, size, x: box.x, y: box.y, experienceIds: menuStyleIds.length ? menuStyleIds : undefined })
      ).finally(() => removeProcessingBox(boxId));
    }
  }, [onAction, menu, selectedIds, nodes, promptInput, aspect, resolution, buildProcessingBox, menuStyleIds, styleNamesByIds, addProcessingBox, removeProcessingBox]);

  // 编辑框执行：使用编辑框自身的 nodeId 和 prompt（不依赖菜单/选中状态）
  // 点生成 → 面板关闭 → 在新图位置（原图右侧）画占位框显示"正在编辑图片..."
  const handleEditPanelExecute = useCallback(() => {
    if (!onAction || !editPanel) return;
    const prompt = editPanel.prompt.trim();
    if (!prompt) return;
    const size = calcSize(editPanel.aspect, editPanel.resolution);
    const node = nodes.find((n) => n.id === editPanel.nodeId);
    if (!node) return;
    const box = buildProcessingBox(editPanel.aspect, [node]);
    const sname = styleNamesByIds(editPanel.experienceIds);
    const expIds = editPanel.experienceIds;
    setEditPanel(null);
    const boxId = addProcessingBox(box, sname ? `正在按《${sname}》编辑图片...` : "正在编辑图片...");
    Promise.resolve(
      onAction({ type: "edit", nodeId: node.id, prompt, size, x: box.x, y: box.y, experienceIds: expIds?.length ? expIds : undefined })
    ).finally(() => removeProcessingBox(boxId));
  }, [onAction, editPanel, nodes, buildProcessingBox, styleNamesByIds, addProcessingBox, removeProcessingBox]);

  const handleDelete = useCallback(() => {
    if (!onAction || selectedIds.size === 0) return;
    onAction({ type: "delete", nodeIds: [...selectedIds] });
    setMenu(null);
  }, [onAction, selectedIds]);

  // 画布内复制选中图片（存入剪贴板状态，Ctrl+V 粘贴到画布）
  const handleCopyImage = useCallback(() => {
    const copies = [...selectedIds]
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => !!n && !!n.image_url);
    setMenu(null);
    if (copies.length === 0) return;
    clipboardRef.current = copies;
    setLocalStatusMsg(`已复制 ${copies.length} 张图片，Ctrl+V 粘贴到画布`);
    setTimeout(() => setLocalStatusMsg(null), 2200);
  }, [selectedIds, nodes]);

  // 另存为：优先用 File System Access API（弹「保存到…」对话框，可选桌面等任意文件夹），
  // 不支持/失败时回退普通下载。两个关键点：
  // 1. showSaveFilePicker 要求点击后的"瞬态激活"窗口内调用——必须先弹框、后 fetch 图片，
  //    否则慢 fetch 会把激活拖过期，保存框永远弹不出来（直接静默下载）；
  // 2. 若上一个保存框未正常结算（被遮挡/失焦），浏览器会拒绝后续所有弹框请求（AbortError），
  //    此处必须给出可见提示而不是静默返回，刷新页面可恢复。
  const handleSaveImage = useCallback(async () => {
    const id = [...selectedIds][0];
    const node = nodes.find((n) => n.id === id);
    setMenu(null);
    if (!node?.image_url) return;

    const showMsg = (msg: string) => {
      setLocalStatusMsg(msg);
      setTimeout(() => setLocalStatusMsg(null), 2200);
    };

    // 从 URL 扩展名推断文件名与类型（弹框前就能确定，不依赖 blob.type）
    const ext = node.image_url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
    const safeExt = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? ext : "png";
    const mime =
      safeExt === "png" ? "image/png"
      : safeExt === "gif" ? "image/gif"
      : safeExt === "webp" ? "image/webp"
      : "image/jpeg";
    const filename = `canvas-${node.id.slice(0, 8)}.${safeExt}`;

    const w = window as unknown as {
      showSaveFilePicker?: (opts?: object) => Promise<{
        createWritable: () => Promise<{
          write: (b: Blob) => Promise<void>;
          close: () => Promise<void>;
          abort?: () => Promise<void>;
        }>;
      }>;
    };
    if (w.showSaveFilePicker) {
      try {
        // 1. 先弹保存框（此刻点击激活必定有效，不受 fetch 快慢影响）
        const handle = await w.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "图片", accept: { [mime]: [`.${safeExt}`] } }],
        });
        // 2. 用户选好位置后再取图写盘（fetch 不需要用户激活）
        let blob: Blob;
        try {
          blob = await fetchImageBlob(node.image_url);
        } catch {
          showMsg("图片加载失败，无法保存");
          return;
        }
        const ws = await handle.createWritable();
        try {
          await ws.write(blob);
          // 只有完整写入后才 close 并提交文件；写入失败时 close 会把空临时文件提交到磁盘。
          await ws.close();
          showMsg("图片已保存");
        } catch (error) {
          // abort 会丢弃未提交写入，也不会覆盖已有文件。
          try {
            await ws.abort?.();
          } catch {
            // 保留原始写入错误，下方回退到普通下载。
          }
          throw error;
        }
        return;
      } catch (e) {
        const err = e as { name?: string };
        if (err?.name === "AbortError") {
          // 真取消 / 上一个保存框还没关闭（浏览器会拒绝重复弹框）——给可见反馈，不再静默
          showMsg("已取消保存");
          return;
        }
        // 其他错误（权限等）走下方回退下载
      }
    }
    // 回退：普通下载（不弹保存框，文件进入浏览器下载文件夹）
    let blob: Blob;
    try {
      blob = await fetchImageBlob(node.image_url);
    } catch {
      showMsg("图片加载失败，无法保存");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 下载由浏览器异步读取 Blob URL；立即 revoke 会在部分浏览器中竞态生成 0 字节文件。
    window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    showMsg("已下载到浏览器下载文件夹");
  }, [selectedIds, nodes]);

  // 打开所在文件夹：调后端用系统文件管理器定位该图片文件（图片以文件形式存于 backend/data/images）
  const handleRevealImage = useCallback(async () => {
    const id = [...selectedIds][0];
    const node = nodes.find((n) => n.id === id);
    setMenu(null);
    if (!node?.image_url) return;
    const showMsg = (msg: string) => {
      setLocalStatusMsg(msg);
      setTimeout(() => setLocalStatusMsg(null), 2200);
    };
    try {
      const r = await revealImageFile(node.image_url);
      showMsg(r.message);
    } catch (e) {
      showMsg(`打开文件夹失败：${(e as Error).message}`);
    }
  }, [selectedIds, nodes]);

  // 空白右键：打开「新建容器」菜单
  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, mode: "background" });
  }, []);

  // 菜单点击「新建图片容器」：在右键位置（转世界坐标）居中创建
  const handleCreateContainer = useCallback(() => {
    if (!menu) return;
    const w = screenToWorld(menu.x, menu.y);
    createContainer(w.x, w.y);
    setMenu(null);
  }, [menu, screenToWorld, createContainer]);

  // 容器生成：0 参考图文生图 / 1 参考图变体 / 多参考图组合（SSE 流式 + 真实预览图）
  const handleContainerGenerate = useCallback(
    async (c: PendingContainer) => {
      if (!canvasId) return;
      // 防重入：生成中（含 textarea Enter 直触）不允许再次发起
      if (generatingContainerIdRef.current) return;
      const prompt = c.prompt.trim();
      const size = calcSize(c.aspect, c.resolution);

      if (c.refIds.length === 0 && !prompt) {
        updateContainer(c.id, { error: "请输入描述，或从图片拖连线进来" });
        return;
      }

      const op =
        c.refIds.length === 0 ? "generate" : c.refIds.length === 1 ? "variate" : "compose";

      setGeneratingContainerId(c.id);
      setGenProgress(5);
      // 估算进度：流式模式下收到真实 preview 事件后自动停用
      let estimating = true;
      const start = Date.now();
      const timer = window.setInterval(() => {
        if (estimating) {
          const t = (Date.now() - start) / 1000;
          // 更陡峭的曲线：1s→33%, 2s→55%, 3s→70%, 5s→86%
          setGenProgress((p) => Math.min(92, Math.max(p, 92 * (1 - Math.exp(-t / 2.5)))));
        } else {
          // 收到预览后，缓慢爬升到 95% 等待最终结果
          setGenProgress((p) => Math.min(95, p + 0.6));
        }
      }, 120);

      const ref = {
        done: null as { success: boolean; message: string; canvas: CanvasState } | null,
      };
      try {
        await generateImageStream(
          canvasId,
          {
            op,
            prompt,
            size,
            x: c.x,
            y: c.y,
            node_id: op === "variate" ? c.refIds[0] : undefined,
            node_ids: op === "compose" ? c.refIds : undefined,
            experience_ids: c.experienceIds?.length ? c.experienceIds : undefined,
          },
          {
            onStart: (mode) => {
              if (mode === "stream") estimating = false;
            },
            onPreview: (url, progress) => {
              estimating = false;
              updateContainer(c.id, { previewUrl: url });
              setGenProgress((p) => Math.max(p, Math.max(40, progress)));
            },
            onDone: (d) => {
              ref.done = d;
            },
          }
        );

        window.clearInterval(timer);
        if (ref.done && ref.done.success) {
          // 1) 进度到 100%，短暂停留让用户看到"完成"
          setGenProgress(100);
          await new Promise((r) => setTimeout(r, 160));
          // 2) 图片入场（淡入缩放 0.35s）与容器退场（淡出缩小 0.32s）交叉进行
          onCanvasUpdate?.(ref.done.canvas);
          updateContainer(c.id, { exiting: true });
          // 3) 等待退场动画完成后再移除容器节点
          await new Promise((r) => setTimeout(r, 380));
          removeContainer(c.id);
        } else {
          setGenProgress(0);
          updateContainer(c.id, {
            error: ref.done?.message || "生成失败，请重试",
            previewUrl: undefined,
          });
        }
      } catch {
        window.clearInterval(timer);
        setGenProgress(0);
        updateContainer(c.id, { error: "生成失败，请重试" });
      } finally {
        window.clearInterval(timer);
        setGeneratingContainerId(null);
      }
    },
    [canvasId, updateContainer, removeContainer, onCanvasUpdate]
  );

  const selectedCount = selectedIds.size;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleBackgroundContextMenu}
      onDragOver={(e) => {
        e.preventDefault(); // 允许放置（否则浏览器直接打开图片文件）
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.types?.includes("Files")) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (!files.length) return;
        const w = screenToWorld(e.clientX, e.clientY);
        uploadImages(files, w.x - 150, w.y - 150);
      }}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#1a1a2e",
        cursor: connecting
          ? "crosshair"
          : marquee
            ? "crosshair"
            : isPanning
              ? "grabbing"
              : draggingNode || draggingContainer
                ? "move"
                : spacePressed
                  ? "grab"
                  : "default",
      }}
    >
      {/* 全局动画 keyframes：图片入场淡入缩放 */}
      <style>{`
        @keyframes ica-img-in {
          from { opacity: 0; transform: scale(0.92); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes ica-proc-pulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(167,139,250,0.95), 0 0 28px rgba(167,139,250,0.5); }
          50%      { box-shadow: 0 0 0 5px rgba(196,181,253,0.55), 0 0 42px rgba(167,139,250,0.9); }
        }
        @keyframes ica-dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%           { transform: translateY(-6px); opacity: 1; }
        }
        .ica-autofit-btn {
          width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 8px; border: 1px solid transparent;
          cursor: pointer; z-index: 500;
          transition: transform .15s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .ica-autofit-btn:hover { transform: scale(1.1); }
        .ica-autofit-btn.on {
          background: rgba(99,102,241,.28); border-color: rgba(99,102,241,.7); color: #c7d2fe;
        }
        .ica-autofit-btn.on:hover { box-shadow: 0 0 10px rgba(99,102,241,.55); }
        .ica-autofit-btn.off { background: rgba(0,0,0,.6); color: #9ca3af; }
        .ica-autofit-btn.off:hover { box-shadow: 0 0 10px rgba(255,255,255,.2); color: #e5e7eb; }
        .ica-fitview-btn {
          width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 8px; border: 1px solid transparent;
          cursor: pointer; z-index: 500;
          background: rgba(0,0,0,.6); color: #9ca3af;
          transition: transform .15s ease, box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .ica-fitview-btn:hover {
          transform: scale(1.1); color: #c7d2fe;
          background: rgba(99,102,241,.28); border-color: rgba(99,102,241,.7);
          box-shadow: 0 0 10px rgba(99,102,241,.55);
        }
        .ica-fitview-btn:active { transform: scale(0.95); }
        /* 风格下拉：原生 select 的选项列表由系统渲染，需全局样式改深色（与设置面板一致） */
        .ic-select { appearance: none; -webkit-appearance: none; cursor: pointer; }
        .ic-select option { background: #26264a; color: #eee; }
      `}</style>
      {/* 网格背景 */}
      <div
        data-role="grid"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)`,
          backgroundSize: `${40 * zoom}px ${40 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          pointerEvents: "none",
        }}
      />

      {/* 画布世界 */}
      <div
        data-role="world"
        style={{
          position: "absolute",
          transformOrigin: "0 0",
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          // 提升为合成层：pan/zoom 变化时 GPU 缩放缓存纹理，不逐帧重光栅化所有图片
          willChange: "transform",
        }}
      >
        {/* 连线层（实线 = 已生成谱系，虚线 = 待生成参考） */}
        <svg
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: "none",
          }}
        >
          <defs>
            {/* 谱系连线箭头：源图 → 生成图 */}
            <marker
              id="ica-arrow-solid"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#6366f1" />
            </marker>
            {/* 参考连线箭头（虚线用浅紫） */}
            <marker
              id="ica-arrow-dashed"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa" />
            </marker>
          </defs>
          {nodes
            .filter((n) => n.source_ids && n.source_ids.length > 0)
            .map((target) =>
              (target.source_ids || []).map((sid) => {
                const src = nodes.find((n) => n.id === sid);
                if (!src) return null;
                const ep = getConnectionEndpoints(src, target);
                const path = `M ${ep.x1} ${ep.y1} C ${ep.cx1} ${ep.cy1}, ${ep.cx2} ${ep.cy2}, ${ep.x2} ${ep.y2}`;
                return (
                  <g key={`${sid}-${target.id}`}>
                    <path
                      d={path}
                      fill="none"
                      stroke="rgba(99,102,241,0.6)"
                      strokeWidth={3}
                      strokeLinecap="round"
                      markerEnd="url(#ica-arrow-solid)"
                    />
                    <circle cx={ep.x1} cy={ep.y1} r={5} fill="#6366f1" />
                  </g>
                );
              })
            )}

          {/* 容器的待生成参考连线（虚线），目标为容器世界矩形 */}
          {containers.map((c) => {
            const tgtRect: BBox = { x: c.x, y: c.y, width: c.w, height: c.h };
            return c.refIds.map((rid) => {
              const src = nodes.find((n) => n.id === rid);
              if (!src) return null;
              const ep = getConnectionEndpoints(src, tgtRect);
              const path = `M ${ep.x1} ${ep.y1} C ${ep.cx1} ${ep.cy1}, ${ep.cx2} ${ep.cy2}, ${ep.x2} ${ep.y2}`;
              return (
                <g key={`${rid}-${c.id}`}>
                  <path
                    d={path}
                    fill="none"
                    stroke="rgba(167,139,250,0.55)"
                    strokeWidth={2.5}
                    strokeDasharray="8 6"
                    strokeLinecap="round"
                    markerEnd="url(#ica-arrow-dashed)"
                  />
                  <circle cx={ep.x1} cy={ep.y1} r={4} fill="#a78bfa" />
                </g>
              );
            });
          })}

          {/* 编辑框锚定连线已移至屏幕层 portal（EditPanel 是 fixed 屏幕元素，
              画在被 scale(zoom) 缩放的世界层会导致连线长度被缩放塌缩） */}

          {/* 拖动中的临时连线 */}
          {connecting &&
            (() => {
              const src = nodes.find((n) => n.id === connecting.fromId);
              if (!src) return null;
              const w = screenToWorld(connecting.x, connecting.y);
              // 使用用户实际点击的端口作为起点
              const x1 = connecting.sx;
              const y1 = connecting.sy;
              const x2 = w.x;
              const y2 = w.y;
              const dx = x2 - x1;
              const dy = y2 - y1;
              const horizontal = Math.abs(dx) >= Math.abs(dy);
              let cx1: number, cy1: number, cx2: number, cy2: number;
              if (horizontal) {
                const offset = Math.min(Math.max(40, Math.abs(dx) / 2), Math.max(12, Math.abs(x2 - x1) / 2));
                const dir = dx >= 0 ? 1 : -1;
                cx1 = x1 + dir * offset;
                cy1 = y1;
                cx2 = x2 - dir * offset;
                cy2 = y2;
              } else {
                const offset = Math.min(Math.max(40, Math.abs(dy) / 2), Math.max(12, Math.abs(y2 - y1) / 2));
                const dir = dy >= 0 ? 1 : -1;
                cx1 = x1;
                cy1 = y1 + dir * offset;
                cx2 = x2;
                cy2 = y2 - dir * offset;
              }
              const path = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
              return (
                <g>
                  <path
                    d={path}
                    fill="none"
                    stroke="rgba(167,139,250,0.9)"
                    strokeWidth={2.5}
                    strokeDasharray="8 6"
                    strokeLinecap="round"
                  />
                  <circle cx={w.x} cy={w.y} r={5} fill="#a78bfa" />
                </g>
              );
            })()}
        </svg>

        {nodes.map((node) => (
          <ImageNode
            key={node.id}
            node={node}
            isDragging={draggingNode === node.id}
            isHovered={hoveredNode === node.id}
            isLinked={!!(node.source_ids && node.source_ids.length >= 2)}
            isSelected={selectedIds.has(node.id)}
            showPorts={hoveredNode === node.id || (connecting?.fromId === node.id)}
            onPortMouseDown={(e, portIdx) => handlePortMouseDown(e, node, portIdx)}
            onMouseDown={(e) => handleNodeMouseDown(e, node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            onContextMenu={(e) => handleNodeContextMenu(e, node)}
          />
        ))}

        {/* 待生成图片容器：world 层渲染，与图片同律缩放（固定在画布坐标上，无相对运动） */}
        {containers.map((c) => (
          <PendingContainerNode
            key={c.id}
            container={c}
            nodes={nodes}
            zoom={zoom}
            isGenerating={generatingContainerId === c.id}
            isDragActive={draggingContainer?.id === c.id}
            isConnectTarget={!!connecting}
            progress={generatingContainerId === c.id ? genProgress : 0}
            experiences={experiences}
            onHeaderMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              const w = screenToWorld(e.clientX, e.clientY);
              setDraggingContainer({ id: c.id, offsetX: w.x - c.x, offsetY: w.y - c.y });
            }}
            onChange={(patch) => updateContainer(c.id, patch)}
            onRemoveRef={(rid) =>
              updateContainer(c.id, { refIds: c.refIds.filter((rr) => rr !== rid) })
            }
            onRemove={() => removeContainer(c.id)}
            onGenerate={() => handleContainerGenerate(c)}
            onActivate={() => {
              activeContainerIdRef.current = c.id;
            }}
          />
        ))}

        {/* 生成中占位框：编辑/变体/组合执行时，新图位置的预留矩形（支持多张同时生成） */}
        {processingBoxes.map((box) => (
          <div
            key={box.id}
            style={{
              position: "absolute",
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              border: "2px solid rgba(167,139,250,0.9)",
              borderRadius: 8,
              background: "rgba(167,139,250,0.10)",
              boxShadow: "0 0 30px rgba(167,139,250,0.35)",
              animation: "ica-proc-pulse 1.2s ease-in-out infinite",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              zIndex: 20,
              pointerEvents: "none",
            }}
          >
            <div style={{ display: "flex", gap: 5 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#c4b5fd",
                    animation: `ica-dot-bounce 1.1s ${i * 0.18}s ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
            <span
              style={{
                color: "#ddd6fe",
                fontSize: 15,
                fontWeight: 600,
                textShadow: "0 1px 8px rgba(0,0,0,0.8)",
              }}
            >
              {box.label}
            </span>
          </div>
        ))}
      </div>

      {/* 框选矩形（屏幕坐标） */}
      {marquee && (
        <div
          style={{
            position: "fixed",
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            background: "rgba(99,102,241,0.15)",
            border: "1px solid #6366f1",
            pointerEvents: "none",
            zIndex: 500,
          }}
        />
      )}

      {/* 拖拽图片文件进入提示 */}
      {dragOver && (
        <div
          style={{
            position: "fixed",
            inset: 16,
            borderRadius: 16,
            border: "2px dashed #818cf8",
            background: "rgba(99,102,241,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            fontWeight: 600,
            color: "#c7d2fe",
            pointerEvents: "none",
            zIndex: 900,
          }}
        >
          松开鼠标，把图片放到画布上
        </div>
      )}

      {/* 右键菜单（普通菜单 / compose / variate 输入框）
          portal 到 body：画布层有 transform: scale(zoom)，否则 position:fixed
          会以变换层为包含块被整体缩放，字号/滚动条放大、边框错位 */}
      {menu && createPortal(
        <ContextMenu
          ref={menuRef}
          x={menu.x}
          y={menu.y}
          mode={menu.mode}
          selectedCount={selectedCount}
          selectedNodeContent={
            selectedCount === 1
              ? nodes.find((n) => n.id === [...selectedIds][0])?.content ?? ""
              : ""
          }
          promptInput={promptInput}
          onPromptChange={setPromptInput}
          aspect={aspect}
          resolution={resolution}
          onAspectChange={setAspect}
          onResolutionChange={setResolution}
          experiences={experiences}
          styleIds={menuStyleIds}
          onStyleChange={setMenuStyleIds}
          onMenuAction={handleMenuAction}
          onExecute={handleExecute}
          onDelete={handleDelete}
          onCopyImage={handleCopyImage}
          onSaveImage={handleSaveImage}
          onRevealImage={handleRevealImage}
          onCreateContainer={handleCreateContainer}
          onAddToChat={handleAddToChat}
          onClose={() => setMenu(null)}
        />,
        document.body,
      )}

      {/* 编辑图片框（独立于右键菜单，可与普通菜单并存；连线在画布 SVG 层渲染）
          portal 到 body，避免被画布 scale(zoom) 缩放（坐标本就是屏幕视口坐标） */}
      {editPanel && createPortal(
        <EditPanel
          ref={editPanelRef}
          x={editPanel.x}
          y={editPanel.y}
          nodeContent={
            nodes.find((n) => n.id === editPanel.nodeId)?.content ?? ""
          }
          prompt={editPanel.prompt}
          onPromptChange={(v) => setEditPanel((p) => (p ? { ...p, prompt: v } : p))}
          aspect={editPanel.aspect}
          resolution={editPanel.resolution}
          onAspectChange={(v) => setEditPanel((p) => (p ? { ...p, aspect: v } : p))}
          onResolutionChange={(v) => setEditPanel((p) => (p ? { ...p, resolution: v } : p))}
          experiences={experiences}
          styleIds={editPanel.experienceIds ?? []}
          onStyleChange={(v) => setEditPanel((p) => (p ? { ...p, experienceIds: v.length ? v : undefined } : p))}
          onExecute={handleEditPanelExecute}
          onClose={() => setEditPanel(null)}
          onMove={(nx, ny) => setEditPanel((p) => (p ? { ...p, x: nx, y: ny } : p))}
          onRect={setEditPanelRect}
        />,
        document.body,
      )}

      {/* 编辑框锚定连线（屏幕层 portal）：源图屏幕矩形 → 面板真实屏幕矩形，
          不随画布 scale(zoom) 缩放，与图片间连线同风格。
          注意：world 层不一定位于画布容器 (0,0)（可能有包裹层偏移），
          故原点取 world 元素真实 rect，而非 container 原点 + pan */}
      {editPanel &&
        (() => {
          const node = nodes.find((n) => n.id === editPanel.nodeId);
          const worldEl = containerRef.current?.querySelector("[data-role=world]");
          if (!node || !worldEl) return null;
          const wr = worldEl.getBoundingClientRect();
          const nodeRect: BBox = {
            x: wr.left + node.x * zoom,
            y: wr.top + node.y * zoom,
            width: node.width * zoom,
            height: node.height * zoom,
          };
          const panelRect: BBox = {
            x: editPanelRect.x,
            y: editPanelRect.y,
            width: editPanelRect.w,
            height: editPanelRect.h,
          };
          return createPortal(
            <EditPanelConnector nodeRect={nodeRect} panelRect={panelRect} />,
            document.body,
          );
        })()}

      {/* 选中数量提示（localStatusMsg 显示时隐藏，避免重叠） */}
      {selectedCount > 0 && !menu && !connecting && !busy && !localStatusMsg && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(99,102,241,0.9)",
            color: "white",
            padding: "6px 14px",
            borderRadius: 8,
            fontSize: 13,
            pointerEvents: "none",
            zIndex: 600,
          }}
        >
          已选 {selectedCount} 张 · 右键打开操作菜单 · Esc 取消
        </div>
      )}

      {/* 连线模式提示 */}
      {connecting && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(167,139,250,0.95)",
            color: "white",
            padding: "6px 14px",
            borderRadius: 8,
            fontSize: 13,
            pointerEvents: "none",
            zIndex: 600,
          }}
        >
          松手到图片容器 = 添加参考图 · 松手到空白处 = 新建容器 · Esc 取消
        </div>
      )}

      {/* 局部操作提示（复制失败等） */}
      {localStatusMsg && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(248,113,113,0.95)",
            color: "white",
            padding: "6px 14px",
            borderRadius: 8,
            fontSize: 13,
            pointerEvents: "none",
            zIndex: 600,
            animation: "ica-fade-out 0.3s 1.9s forwards",
          }}
        >
          {localStatusMsg}
        </div>
      )}

      {/* 自动适配相机视角开关 */}
      <button
        type="button"
        className={`ica-autofit-btn ${autoFit ? "on" : "off"}`}
        title={
          autoFit
            ? "自动适配视图：已开启（节点增减时自动缩放居中）· 点击关闭"
            : "自动适配视图：已关闭 · 点击开启"
        }
        style={{ position: "absolute", bottom: 16, left: 16 }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggleAutoFit();
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 9V5a1 1 0 0 1 1-1h4" />
          <path d="M15 4h4a1 1 0 0 1 1 1v4" />
          <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
          {!autoFit && <line x1="4.5" y1="19.5" x2="19.5" y2="4.5" />}
        </svg>
      </button>

      {/* 回到全图视角按钮：手动触发一次适配全部节点（不受开关影响） */}
      <button
        type="button"
        className="ica-fitview-btn"
        title="回到全图视角：缩放并居中显示所有内容"
        style={{ position: "absolute", bottom: 16, left: 56 }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          fitAllNodes();
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>

      {/* 自动整理按钮：网格对齐所有图片（后端重排，可撤销） */}
      <button
        type="button"
        className="ica-fitview-btn"
        title="自动整理：按连线层级排列（根图在左，派生图向右展开，可撤销）"
        style={{ position: "absolute", bottom: 16, left: 96 }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={async (e) => {
          e.stopPropagation();
          if (!onAction) return;
          const ok = await onAction({ type: "arrange" });
          // 置位待执行标志：等新画布状态渲染出最新节点坐标后再 fit（见 pendingFitRef effect）
          if (ok !== false) pendingFitRef.current = true;
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      </button>

      {/* 缩放指示器：钉在视口右下角（对话圆按钮已上移避让）；对话面板展开时只做水平避让（贴面板左外缘），纵向永不移动 */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          right: chatDockWidth > 0 ? chatDockWidth + 24 : 16,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 12,
          pointerEvents: "none",
          transition: "right 0.18s ease",
          zIndex: 500,
        }}
      >
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}

// 风格多选下拉（风格库为空时隐藏；深色底浅字，选中后每份风格全文依次拼接进生成提示词）
function StyleSelect({
  experiences,
  value,
  onChange,
}: {
  experiences: ExperienceMeta[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 下拉的 fixed 定位（打开时刻按按钮屏幕矩形计算；按钮在缩放的容器面板内时 rect 仍是真实屏幕坐标）
  const [listPos, setListPos] = useState({ left: 0, top: 0, width: 0, maxH: 208 });

  // 打开时计算定位：portal 到 body + fixed，避免被 EditPanel 内容区 overflow:hidden、
  // 画布世界层裁剪、容器面板 transform:scale 等任何父级上下文裁剪/缩放
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const maxH = Math.max(120, Math.min(208, window.innerHeight - r.bottom - 12));
    setListPos({ left: r.left, top: r.bottom + 4, width: r.width, maxH });
  }, [open]);

  // 点击组件外部/按 Esc 关闭下拉。
  // 用捕获阶段监听：EditPanel/ContextMenu 根节点对 mousedown stopPropagation（阻止画布拖拽），
  // 冒泡阶段的 document 监听收不到事件，点面板内其他区域时下拉关不掉
  useEffect(() => {
    if (!open) return;
    const onDocDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        // 只关下拉：阻止 Esc 继续传播关闭编辑框/菜单/容器
        ev.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (experiences.length === 0) return null;

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  const names = experiences.filter((e) => value.includes(e.id)).map((e) => e.name);
  const label =
    names.length === 0
      ? "无（自由发挥）"
      : names.length === 1
        ? names[0]
        : `已选 ${names.length} 个风格`;

  return (
    <div ref={rootRef} style={{ marginTop: 10 }}>
      <div style={{ fontSize: 14, color: "rgba(255,255,255,0.78)", marginBottom: 6 }}>风格（可多选）</div>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="选中后，每份风格指南全文会依次拼接进生成提示词"
        style={{
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          color: names.length ? "#c4b5fd" : "#eee",
          fontSize: 15,
          padding: "9px 10px",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 11, opacity: 0.6, flexShrink: 0 }}>▼</span>
      </button>
      {open && createPortal(
        <div
          ref={listRef}
          style={{
            position: "fixed",
            left: listPos.left,
            top: listPos.top,
            width: listPos.width,
            boxSizing: "border-box",
            zIndex: 1100,
            background: "rgba(20,20,40,0.98)",
            border: "1px solid rgba(167,139,250,0.5)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
            maxHeight: listPos.maxH,
            overflowY: "auto",
            padding: 4,
          }}
        >
          {experiences.map((e) => {
            const checked = value.includes(e.id);
            return (
              <div
                key={e.id}
                onClick={() => toggle(e.id)}
                title={e.description || e.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  color: checked ? "#c4b5fd" : "rgba(255,255,255,0.85)",
                  fontSize: 14,
                  background: "transparent",
                  userSelect: "none",
                }}
                onMouseEnter={(ev) => {
                  ev.currentTarget.style.background = "rgba(167,139,250,0.12)";
                }}
                onMouseLeave={(ev) => {
                  ev.currentTarget.style.background = "transparent";
                }}
              >
                {/* 复选框 */}
                <span
                  style={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    borderRadius: 4,
                    border: `1.5px solid ${checked ? "#a78bfa" : "rgba(255,255,255,0.35)"}`,
                    background: checked ? "#a78bfa" : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#1a1a2e",
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: 1,
                  }}
                >
                  {checked ? "✓" : ""}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * 右键上下文菜单：操作列表 / prompt 输入框两种形态
 */
const ContextMenu = ({
  ref,
  x,
  y,
  mode,
  selectedCount,
  selectedNodeContent,
  promptInput,
  onPromptChange,
  aspect,
  resolution,
  onAspectChange,
  onResolutionChange,
  experiences,
  styleIds,
  onStyleChange,
  onMenuAction,
  onExecute,
  onDelete,
  onCopyImage,
  onSaveImage,
  onRevealImage,
  onCreateContainer,
  onAddToChat,
  onClose,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  mode: "menu" | "compose" | "variate" | "background";
  selectedCount: number;
  selectedNodeContent: string;
  promptInput: string;
  onPromptChange: (v: string) => void;
  aspect: string;
  resolution: string;
  onAspectChange: (v: string) => void;
  onResolutionChange: (v: string) => void;
  experiences: ExperienceMeta[];
  styleIds: string[];
  onStyleChange: (v: string[]) => void;
  onMenuAction: (mode: "compose" | "variate" | "edit") => void;
  onExecute: () => void;
  onDelete: () => void;
  onCopyImage: () => void;
  onSaveImage: () => void;
  onRevealImage: () => void;
  onCreateContainer: () => void;
  onAddToChat: () => void;
  onClose: () => void;
}) => {
  // 输入模式（组合/变体/编辑）加宽，操作菜单保持紧凑
  const MENU_W = mode === "menu" || mode === "background" ? 260 : 340;
  // 菜单可拖动：初始位置用传入坐标，拖动后用 offset 覆盖
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const dragStart = useRef<{ mx: number; my: number; left: number; top: number } | null>(null);
  const baseLeft = Math.min(x, window.innerWidth - MENU_W - 8);
  const baseTop = Math.min(y, window.innerHeight - (mode === "menu"
    ? (selectedCount === 1 && selectedNodeContent ? 320 : 200)
    : 435));
  const left = dragOffset ? Math.max(0, Math.min(baseLeft + dragOffset.dx, window.innerWidth - MENU_W - 8)) : baseLeft;
  const top = dragOffset ? Math.max(0, Math.min(baseTop + dragOffset.dy, window.innerHeight - 40)) : baseTop;

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragStart.current = { mx: e.clientX, my: e.clientY, left, top };
    const onMove = (ev: MouseEvent) => {
      if (!dragStart.current) return;
      setDragOffset({
        dx: ev.clientX - dragStart.current.mx,
        dy: ev.clientY - dragStart.current.my,
      });
    };
    const onUp = () => {
      dragStart.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [left, top]);

  const itemStyle: React.CSSProperties = {
    padding: "8px 14px",
    fontSize: 13,
    color: "#e5e7eb",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };
  const hoverBg = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.background = "rgba(99,102,241,0.25)";
  };
  const hoverOut = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.background = "transparent";
  };

  // 输入框模式（组合 / 变体）
  const inputPlaceholder =
    mode === "compose"
      ? "组合描述，留空直接生成"
      : "变体描述，留空直接生成";

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left,
        top,
        width: MENU_W,
        background: "rgba(26,26,46,0.97)",
        border: "1px solid rgba(99,102,241,0.5)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        padding: 6,
        zIndex: 1000,
        backdropFilter: "blur(8px)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 标题栏（可拖拽移动整个菜单） */}
      <div
        onMouseDown={onTitleMouseDown}
        style={{
          padding: "6px 14px 8px",
          fontSize: 11,
          color: "rgba(255,255,255,0.45)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 4,
          cursor: "move",
          userSelect: "none",
        }}
      >
        {mode === "menu"
          ? `已选中 ${selectedCount} 张图片`
          : mode === "background"
            ? "画布空白处"
            : "描述（可选）"}
        <span style={{ float: "right", opacity: 0.4, fontSize: 10 }}>⠿ 拖</span>
      </div>

      {/* 选中图片的生成提示词（详情，可鼠标选中复制） */}
      {mode === "menu" && selectedCount === 1 && selectedNodeContent && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 12,
            color: "#c7d2fe",
            background: "rgba(99,102,241,0.08)",
            borderRadius: 6,
            margin: "0 6px 6px",
            lineHeight: 1.5,
            maxHeight: 120,
            overflowY: "auto",
            wordBreak: "break-word",
            userSelect: "text",
          }}
        >
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
            生成提示词
          </div>
          {selectedNodeContent}
        </div>
      )}

      {mode === "background" ? (
        <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={onCreateContainer}>
          <span>📦 新建图片容器</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>拖线生成</span>
        </div>
      ) : mode === "menu" ? (
        <>
          {selectedCount >= 2 && (
            <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={() => onMenuAction("compose")}>
              <span>✨ 组合生成</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>≥2 张</span>
            </div>
          )}
          <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={onAddToChat}>
            <span>💬 添加到对话</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
              引用{selectedCount > 1 ? ` ${selectedCount} 张` : " #"}
            </span>
          </div>
          {selectedCount === 1 && (
            <>
              <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={() => onMenuAction("variate")}>
                <span>🎨 生成变体</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>图生图</span>
              </div>
              <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={() => onMenuAction("edit")}>
                <span>✏️ 编辑图片</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>局部修改</span>
              </div>
              <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={onCopyImage}>
                <span>📋 复制图片</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>粘贴到电脑</span>
              </div>
              <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={onSaveImage}>
                <span>💾 另存为...</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>下载 PNG</span>
              </div>
              <div style={itemStyle} onMouseEnter={hoverBg} onMouseLeave={hoverOut} onClick={onRevealImage}>
                <span>📂 打开所在文件夹</span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>定位文件</span>
              </div>
            </>
          )}
          <div
            style={{ ...itemStyle, color: "#f87171" }}
            onMouseEnter={hoverBg}
            onMouseLeave={hoverOut}
            onClick={onDelete}
          >
            <span>🗑️ 删除{selectedCount > 1 ? ` ${selectedCount} 张` : ""}</span>
          </div>
        </>
      ) : (
        <div style={{ padding: "8px 10px" }}>
          <textarea
            autoFocus
            value={promptInput}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onExecute();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={inputPlaceholder}
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(99,102,241,0.5)",
              borderRadius: 6,
              color: "white",
              fontSize: 13,
              outline: "none",
              resize: "none",
              fontFamily: "inherit",
              lineHeight: 1.5,
            }}
          />

          {/* 尺寸选择：宽高比 + 分辨率 */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 5 }}>
              宽高比
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r.key}
                  onClick={() => onAspectChange(r.key)}
                  style={{
                    flex: 1,
                    padding: "5px 0",
                    background: aspect === r.key ? "#6366f1" : "rgba(255,255,255,0.08)",
                    color: aspect === r.key ? "white" : "rgba(255,255,255,0.6)",
                    border: "none",
                    borderRadius: 5,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {r.key}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", margin: "8px 0 5px" }}>
              分辨率
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {RESOLUTIONS.map((res) => (
                <button
                  key={res}
                  onClick={() => onResolutionChange(res)}
                  style={{
                    flex: 1,
                    padding: "5px 0",
                    background: resolution === res ? "#6366f1" : "rgba(255,255,255,0.08)",
                    color: resolution === res ? "white" : "rgba(255,255,255,0.6)",
                    border: "none",
                    borderRadius: 5,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {res}
                </button>
              ))}
            </div>
          </div>

          {/* 风格选择（风格库为空时隐藏） */}
          <StyleSelect experiences={experiences} value={styleIds} onChange={onStyleChange} />

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={onExecute}
              style={{
                flex: 1,
                padding: "7px 0",
                background: "#6366f1",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              执行
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: "7px 0",
                background: "rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.7)",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 编辑框锚定连线（屏幕层）：源图屏幕矩形 → 编辑框屏幕矩形。
 * EditPanel 是 fixed 屏幕元素（不随画布 zoom 缩放），其连线也必须画在屏幕坐标系，
 * 否则放在被 scale(zoom) 缩放的世界 SVG 层里，连线屏幕长度会随 zoom 塌缩/放大、线宽变化。
 * 两端都直接用真实 DOM 的 getBoundingClientRect，因此拖动面板/拉宽/面板贴边 clamp 都自动对齐。
 */
function EditPanelConnector({ nodeRect, panelRect }: { nodeRect: BBox; panelRect: BBox }) {
  const ep = getConnectionEndpoints(nodeRect, panelRect);
  const path = `M ${ep.x1} ${ep.y1} C ${ep.cx1} ${ep.cy1}, ${ep.cx2} ${ep.cy2}, ${ep.x2} ${ep.y2}`;
  return (
    <svg
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 999,
      }}
    >
      <defs>
        <marker
          id="ica-edit-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa" />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        stroke="rgba(167,139,250,0.85)"
        strokeWidth={2.5}
        strokeDasharray="8 6"
        strokeLinecap="round"
        markerEnd="url(#ica-edit-arrow)"
      />
      <circle cx={ep.x1} cy={ep.y1} r={4} fill="#a78bfa" />
    </svg>
  );
}

/**
 * 编辑图片框：独立浮窗，带连线指向源图（连线在屏幕层 portal 渲染）。
 * 与右键菜单并存，只能 Esc/取消关闭。prompt 必填。
 * 位置由父组件控制（拖动时 onMove 回调更新父组件 state，连线随之更新）。
 */
const EditPanel = ({
  ref,
  x,
  y,
  nodeContent,
  prompt,
  onPromptChange,
  aspect,
  resolution,
  onAspectChange,
  onResolutionChange,
  experiences,
  styleIds,
  onStyleChange,
  onExecute,
  onClose,
  onMove,
  onRect,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  nodeContent: string;
  prompt: string;
  onPromptChange: (v: string) => void;
  aspect: string;
  resolution: string;
  onAspectChange: (v: string) => void;
  onResolutionChange: (v: string) => void;
  experiences: ExperienceMeta[];
  styleIds: string[];
  onStyleChange: (v: string[]) => void;
  onExecute: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onRect: (rect: { x: number; y: number; w: number; h: number }) => void;
}) => {
  // 可拉伸尺寸：宽度持久化；高度默认自适应（null），拉伸过一次后固定并持久化
  const [panelW, setPanelW] = useState<number>(() => {
    const v = Number(localStorage.getItem("ica:editPanelW"));
    return Number.isFinite(v) && v >= 340 && v <= 720 ? v : 340;
  });
  const [panelH, setPanelH] = useState<number | null>(() => {
    const v = Number(localStorage.getItem("ica:editPanelH"));
    return Number.isFinite(v) && v >= 420 ? v : null;
  });
  const [resizeHover, setResizeHover] = useState(false);
  const left = Math.min(x, window.innerWidth - panelW - 8);
  // 固定高度时按真实高度钳制；自适应时按含风格选择/原始提示词的最大内容估算
  const estH = panelH ?? (nodeContent && nodeContent !== "本地图片" ? 500 : 435);
  const top = Math.min(y, window.innerHeight - estH - 8);

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = left;
    const origTop = top;
    const onMov = (ev: MouseEvent) => {
      const nl = Math.max(0, Math.min(origLeft + ev.clientX - startX, window.innerWidth - panelW - 8));
      const nt = Math.max(0, Math.min(origTop + ev.clientY - startY, window.innerHeight - 40));
      onMove(nl, nt);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMov);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMov);
    document.addEventListener("mouseup", onUp);
  }, [left, top, onMove, panelW]);

  // 拉伸：角落同时调宽高（宽 340~720）；四边逐轴拉伸（e/w 调宽、n/s 调高，对边锚定）
  const onResizeMouseDown = useCallback((e: React.MouseEvent, dir: "corner" | "n" | "s" | "e" | "w") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = panelW;
    const origH = panelH ?? ref.current?.offsetHeight ?? 420;
    let lastW = origW;
    let lastH = origH;
    const onMov = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dir === "corner" || dir === "e") lastW = Math.max(340, Math.min(origW + dx, 720));
      if (dir === "w") lastW = Math.max(340, Math.min(origW - dx, 720));
      if (dir === "corner" || dir === "s") lastH = Math.max(420, origH + dy);
      if (dir === "n") lastH = Math.max(420, origH - dy);
      // 左边柄：右边锚定、左边跟随；顶到视口 0 后宽度停止增长（右缘保持原位）
      if (dir === "w") {
        const nl = left + origW - lastW;
        if (nl < 0) {
          lastW = Math.max(340, left + origW);
          onMove(0, top);
        } else {
          onMove(nl, top);
        }
      }
      // 上边柄：底边锚定、顶边跟随；顶到视口 0 后高度停止增长（底缘保持原位）
      if (dir === "n") {
        const nt = top + origH - lastH;
        if (nt < 0) {
          lastH = Math.max(420, top + origH);
          onMove(left, 0);
        } else {
          onMove(left, nt);
        }
      }
      // 底边/角落向下超出视口 → 面板顶边上移（向上生长）；顶到 0 后高度钳制在视口内
      if (dir === "corner" || dir === "s") {
        const overflow = top + lastH - (window.innerHeight - 8);
        if (overflow > 0) {
          const newTop = Math.max(0, top - overflow);
          onMove(left, newTop);
          if (newTop === 0) lastH = Math.max(420, window.innerHeight - 8);
        }
      }
      setPanelW(lastW);
      setPanelH(lastH);
    };
    const onUp = () => {
      localStorage.setItem("ica:editPanelW", String(lastW));
      localStorage.setItem("ica:editPanelH", String(lastH));
      document.removeEventListener("mousemove", onMov);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMov);
    document.addEventListener("mouseup", onUp);
  }, [panelW, panelH, top, left, onMove, ref]);

  // 回报真实屏幕矩形（含贴边 clamp 后的 left/top 与实际宽高），供屏幕层连线终点对齐。
  // useLayoutEffect 在浏览器绘制前同步；ResizeObserver 兜底内容撑高（高度自适应时）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      onRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [left, top, panelW, panelH, onRect, ref]);

  const canExecute = prompt.trim().length > 0;

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left,
        top,
        width: panelW,
        height: panelH ?? undefined,
        display: "flex",
        flexDirection: "column",
        background: "rgba(26,26,46,0.97)",
        border: "1px solid rgba(167,139,250,0.6)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        padding: 6,
        zIndex: 1000,
        backdropFilter: "blur(8px)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 标题栏（可拖拽移动） */}
      <div
        onMouseDown={onTitleMouseDown}
        style={{
          padding: "6px 14px 8px",
          fontSize: 13,
          color: "#c7d2fe",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 4,
          cursor: "move",
          userSelect: "none",
        }}
      >
        ✏️ 编辑图片
        <span style={{ float: "right", opacity: 0.4, fontSize: 10 }}>⠿ 拖</span>
      </div>

      {/* 源图原始提示词（可鼠标选中复制） */}
      {nodeContent && nodeContent !== "本地图片" && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: 12,
            color: "#c7d2fe",
            background: "rgba(167,139,250,0.08)",
            borderRadius: 6,
            margin: "0 6px 6px",
            lineHeight: 1.5,
            maxHeight: 72,
            overflowY: "auto",
            wordBreak: "break-word",
            userSelect: "text",
          }}
        >
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>
            原始提示词
          </div>
          {nodeContent}
        </div>
      )}

      <div
        style={{
          padding: "8px 10px",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && canExecute) {
              e.preventDefault();
              onExecute();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="编辑描述（必填），如：把背景改成星空"
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(167,139,250,0.5)",
            borderRadius: 6,
            color: "white",
            fontSize: 13,
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            lineHeight: 1.5,
            // 拉伸过高度后（panelH 固定），输入框弹性填满剩余空间；
            // 空间不足时允许收缩到 0，保证底部按钮永远在边框内（minHeight 60 会顶住收缩导致按钮溢出）
            flex: panelH ? "1 1 auto" : undefined,
            minHeight: panelH ? 0 : 60,
          }}
        />

        {/* 尺寸选择：宽高比 + 分辨率 */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 5 }}>
            宽高比
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {ASPECT_RATIOS.map((r) => (
              <button
                key={r.key}
                onClick={() => onAspectChange(r.key)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  background: aspect === r.key ? "#a78bfa" : "rgba(255,255,255,0.08)",
                  color: aspect === r.key ? "white" : "rgba(255,255,255,0.6)",
                  border: "none",
                  borderRadius: 5,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {r.key}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "8px 0 5px" }}>
            分辨率
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {RESOLUTIONS.map((res) => (
              <button
                key={res}
                onClick={() => onResolutionChange(res)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  background: resolution === res ? "#a78bfa" : "rgba(255,255,255,0.08)",
                  color: resolution === res ? "white" : "rgba(255,255,255,0.6)",
                  border: "none",
                  borderRadius: 5,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {res}
              </button>
            ))}
          </div>
        </div>

        {/* 风格选择（风格库为空时隐藏） */}
        <StyleSelect experiences={experiences} value={styleIds} onChange={onStyleChange} />

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            onClick={onExecute}
            disabled={!canExecute}
            style={{
              flex: 1,
              padding: "7px 0",
              background: canExecute ? "#a78bfa" : "rgba(167,139,250,0.3)",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              cursor: canExecute ? "pointer" : "not-allowed",
            }}
          >
            执行
          </button>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "7px 0",
              background: "rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.7)",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            取消
          </button>
        </div>
      </div>

      {/* 四边拉伸热区：跨边框的隐形热区，仅光标形状反馈（与容器一致）；
          两端各让出 32px 避开右下角手柄 */}
      {(["n", "s", "e", "w"] as const).map((dir) => {
        const st: React.CSSProperties = {
          position: "absolute",
          zIndex: 10,
          background: "transparent",
        };
        if (dir === "n") Object.assign(st, { top: -5, left: 32, right: 32, height: 10, cursor: "ns-resize" });
        if (dir === "s") Object.assign(st, { bottom: -5, left: 32, right: 32, height: 10, cursor: "ns-resize" });
        if (dir === "e") Object.assign(st, { right: -5, top: 32, bottom: 32, width: 10, cursor: "ew-resize" });
        if (dir === "w") Object.assign(st, { left: -5, top: 32, bottom: 32, width: 10, cursor: "ew-resize" });
        return <div key={dir} style={st} onMouseDown={(e) => onResizeMouseDown(e, dir)} />;
      })}

      {/* 右下角拉伸手柄：平时隐形热区，hover 显示对角线指示 */}
      <div
        onMouseDown={(e) => onResizeMouseDown(e, "corner")}
        onMouseEnter={() => setResizeHover(true)}
        onMouseLeave={() => setResizeHover(false)}
        title="拖拽调整编辑框大小"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 28,
          height: 28,
          cursor: "nwse-resize",
          zIndex: 10,
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            opacity: resizeHover ? 1 : 0,
            transition: "opacity 0.15s ease",
          }}
        >
          <line x1="23" y1="12" x2="12" y2="23" stroke="#c4b5fd" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="23" y1="17.5" x2="17.5" y2="23" stroke="#c4b5fd" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
};

/**
 * 图片节点：渲染单个图片，可拖拽、可选中，hover 显示连接点
 */
function ImageNode({
  node,
  isDragging,
  isHovered,
  isLinked,
  isSelected,
  showPorts,
  onPortMouseDown,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
}: {
  node: CanvasNode;
  isDragging: boolean;
  isHovered: boolean;
  isLinked: boolean;
  isSelected: boolean;
  showPorts: boolean;
  onPortMouseDown: (e: React.MouseEvent, portIdx: number) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hoveredPortIdx, setHoveredPortIdx] = useState<number | null>(null);
  if (node.type === "image" && node.image_url) {
    // 四边中点连接点（相对 wrapper 的坐标）
    const ports = showPorts
      ? [
          { x: node.width / 2, y: 0 },
          { x: node.width, y: node.height / 2 },
          { x: node.width / 2, y: node.height },
          { x: 0, y: node.height / 2 },
        ]
      : [];
    return (
      // wrapper 统一处理 hover/拖拽/右键：图片和连接点是同一交互整体，
      // 鼠标在图片和连接点之间移动不会触发 mouseleave（连接点不会闪没）
      <div
        style={{
          position: "absolute",
          left: node.x,
          top: node.y,
          width: node.width,
          height: node.height,
          cursor: isDragging ? "move" : "pointer",
          // 入场动画：淡入 + 轻微缩放，仅首次挂载播放一次
          animation: "ica-img-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both",
        }}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onContextMenu={onContextMenu}
      >
        <img
          src={node.image_url}
          alt={node.content || "image"}
          draggable={false}
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            // 后端会按真实比例修正节点；修正前/远程图读取失败时也保证内容不被裁切
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: isSelected
              ? "0 0 0 2px #6366f1, 0 8px 40px rgba(99,102,241,0.6)"
              : isDragging
                ? "0 8px 40px rgba(99,102,241,0.5)"
                : isHovered
                  ? "0 4px 24px rgba(255,255,255,0.2)"
                  : "0 4px 20px rgba(0,0,0,0.4)",
            outline: isDragging
              ? "2px solid #6366f1"
              : isSelected
                ? "2px solid #6366f1"
                : isHovered
                  ? "1px solid rgba(255,255,255,0.3)"
                  : isLinked
                    ? "1px solid rgba(99,102,241,0.4)"
                    : "none",
            userSelect: "none",
            transition: isDragging ? "none" : "box-shadow 0.2s, outline 0.2s",
          }}
        />
        {/* 编号 badge：用户与 Agent 用 #N 指代图片（右键"添加到对话"引用也用它） */}
        {node.index != null && (
          <div
            title={`#${node.index}`}
            style={{
              position: "absolute",
              left: 6,
              top: 6,
              minWidth: 24,
              padding: "1px 6px",
              borderRadius: 6,
              background: "rgba(0,0,0,0.55)",
              color: "#e0e7ff",
              fontSize: 11,
              fontWeight: 600,
              lineHeight: "18px",
              textAlign: "center",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            #{node.index}
          </div>
        )}
        {ports.map((p, i) => {
          const isHovered = hoveredPortIdx === i;
          return (
            <div
              key={i}
              onMouseDown={(e) => onPortMouseDown(e, i)}
              onMouseEnter={() => setHoveredPortIdx(i)}
              onMouseLeave={() => setHoveredPortIdx(null)}
              title="按住拖到图片容器（或空白处）建立参考连线"
              style={{
                position: "absolute",
                left: p.x - 16,
                top: p.y - 16,
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "crosshair",
                zIndex: 10,
              }}
            >
              <div
                style={{
                  width: isHovered ? 18 : 14,
                  height: isHovered ? 18 : 14,
                  borderRadius: "50%",
                  background: "#a78bfa",
                  border: "2px solid #fff",
                  boxShadow: isHovered
                    ? "0 0 18px rgba(167,139,250,1)"
                    : "0 0 10px rgba(167,139,250,0.9)",
                  transition: "width 0.15s ease, height 0.15s ease, box-shadow 0.15s ease",
                  pointerEvents: "none",
                }}
              />
            </div>
          );
        })}
        {isLinked && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: -24,
              background: "rgba(99,102,241,0.9)",
              color: "white",
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 500,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            组合结果
          </div>
        )}
      </div>
    );
  }

  // 文本节点
  if (node.content) {
    return (
      <div
        style={{
          position: "absolute",
          left: node.x,
          top: node.y,
          width: node.width,
          padding: "12px 16px",
          background: "rgba(255,255,255,0.95)",
          borderRadius: 8,
          fontSize: 14,
          color: "#333",
          boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          pointerEvents: "none",
          userSelect: "none",
          wordBreak: "break-word",
        }}
      >
        {node.content}
      </div>
    );
  }

  return null;
}

/**
 * 容器边缘/四角拉伸柄：纯隐形热区，仅以光标形状作为反馈
 * （悬停高亮会遮挡关闭按钮等界面元素，故不做视觉指示）。
 * thickness 为面板本地坐标值（调用方按 s×zoom 补偿，保证屏幕热区恒定）。
 */
function ContainerResizeHandle({
  dir,
  thickness,
  onDown,
}: {
  dir: string;
  thickness: number;
  onDown: (e: React.MouseEvent, dir: string) => void;
}) {
  const corner = thickness * 2; // 角柄方形热区稍大更好抓
  const style: React.CSSProperties = {
    position: "absolute",
    zIndex: 30,
    background: "transparent",
  };
  if (dir === "n")
    Object.assign(style, { top: -thickness / 2, left: corner, right: corner, height: thickness, cursor: "ns-resize" });
  else if (dir === "s")
    Object.assign(style, { bottom: -thickness / 2, left: corner, right: corner, height: thickness, cursor: "ns-resize" });
  else if (dir === "e")
    Object.assign(style, { right: -thickness / 2, top: corner, bottom: corner, width: thickness, cursor: "ew-resize" });
  else if (dir === "w")
    Object.assign(style, { left: -thickness / 2, top: corner, bottom: corner, width: thickness, cursor: "ew-resize" });
  else if (dir === "ne")
    Object.assign(style, { top: -thickness / 2, right: -thickness / 2, width: corner, height: corner, cursor: "nesw-resize" });
  else if (dir === "nw")
    Object.assign(style, { top: -thickness / 2, left: -thickness / 2, width: corner, height: corner, cursor: "nwse-resize" });
  else if (dir === "se")
    Object.assign(style, { bottom: -thickness / 2, right: -thickness / 2, width: corner, height: corner, cursor: "nwse-resize" });
  else if (dir === "sw")
    Object.assign(style, { bottom: -thickness / 2, left: -thickness / 2, width: corner, height: corner, cursor: "nesw-resize" });
  return <div style={style} onMouseDown={(e) => onDown(e, dir)} />;
}

/**
 * 待生成图片容器：画布原生元素（世界坐标渲染、随相机缩放），
 * 面板内容按自然尺寸排版后整体 scale(s)——创建时刻屏幕上恒为基准 UI
 */
function PendingContainerNode({
  container,
  nodes,
  zoom,
  isGenerating,
  isDragActive,
  isConnectTarget,
  progress,
  experiences,
  onHeaderMouseDown,
  onChange,
  onRemoveRef,
  onRemove,
  onGenerate,
  onActivate,
}: {
  container: PendingContainer;
  nodes: CanvasNode[];
  zoom: number;
  isGenerating: boolean;
  isDragActive: boolean;
  isConnectTarget: boolean;
  progress: number;
  experiences: ExperienceMeta[];
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onChange: (patch: Partial<PendingContainer>) => void;
  onRemoveRef: (nodeId: string) => void;
  onRemove: () => void;
  onGenerate: () => void;
  onActivate: () => void;
}) {
  const refNodes = container.refIds
    .map((rid) => nodes.find((n) => n.id === rid))
    .filter((n): n is CanvasNode => !!n);
  const modeLabel =
    refNodes.length === 0
      ? "文生图"
      : refNodes.length === 1
        ? "图生图 · 1 参考图"
        : `多图组合 · ${refNodes.length} 参考图`;
  // 当前宽高比（迷你形状预览用）
  const aspectRatio =
    ASPECT_RATIOS.find((r) => r.key === container.aspect) ?? ASPECT_RATIOS[0];

  // 选项按钮：15px 字号 + 9px 上下内距 ≈ 39px 高的触控目标（Fitts 定律 ≥ 38px 舒适区）
  const smallBtn = (active: boolean): React.CSSProperties => ({
    padding: "9px 0",
    background: active ? "#a78bfa" : "rgba(255,255,255,0.08)",
    color: active ? "#1a1a2e" : "rgba(255,255,255,0.85)",
    border: "none",
    borderRadius: 6,
    fontSize: 15,
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
  });

  // 内容统一缩放系数：取两轴换算比的较小者。字体与纵向间距只随 s 缩放（字形不变形），
  // 较长的一轴由 width:100%/flex 控件自然重排补足——逐轴拉伸时描述框变宽/变高而文字不变形
  const s = Math.min(container.w / CONTAINER_BASE_W, container.h / CONTAINER_BASE_H);

  // ===== 拉伸：边柄逐轴拉伸（重排不变形），角柄整体等比缩放 =====
  const [resizeDir, setResizeDir] = useState<string | null>(null);
  const resizeStartRef = useRef<{ mx: number; my: number; x: number; y: number; w: number; h: number } | null>(null);

  const onHandleDown = (e: React.MouseEvent, dir: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    resizeStartRef.current = { mx: e.clientX, my: e.clientY, x: container.x, y: container.y, w: container.w, h: container.h };
    setResizeDir(dir);
  };

  useEffect(() => {
    if (!resizeDir) return;
    const cursor =
      resizeDir === "n" || resizeDir === "s"
        ? "ns-resize"
        : resizeDir === "e" || resizeDir === "w"
          ? "ew-resize"
          : resizeDir === "ne" || resizeDir === "sw"
            ? "nesw-resize"
            : "nwse-resize";
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = cursor;
    const MIN_W = 240 / zoom; // 拉伸下限：屏幕上仍可读
    const MIN_H = 160 / zoom;
    const onMove = (e: MouseEvent) => {
      const s0 = resizeStartRef.current;
      if (!s0) return;
      const dx = (e.clientX - s0.mx) / zoom;
      const dy = (e.clientY - s0.my) / zoom;
      let w = s0.w;
      let h = s0.h;
      if (resizeDir === "e") w = s0.w + dx;
      else if (resizeDir === "w") w = s0.w - dx;
      else if (resizeDir === "s") h = s0.h + dy;
      else if (resizeDir === "n") h = s0.h - dy;
      else {
        // 角柄：等比缩放（内容整体缩放保持比例），取两轴中变化较大者保证跟手
        const fx = (s0.w + (resizeDir.includes("e") ? dx : -dx)) / s0.w;
        const fy = (s0.h + (resizeDir.includes("s") ? dy : -dy)) / s0.h;
        const f = Math.max(fx, fy);
        w = s0.w * f;
        h = s0.h * f;
      }
      if (w < MIN_W) w = MIN_W;
      if (h < MIN_H) h = MIN_H;
      let { x, y } = s0;
      // 拉伸时对侧边/角固定不动
      if (resizeDir.includes("w")) x = s0.x + s0.w - w;
      if (resizeDir.includes("n")) y = s0.y + s0.h - h;
      onChange({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const onUp = () => setResizeDir(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizeDir, zoom, onChange]);

  // 拉伸柄热区厚度：屏幕恒定（约 12px），面板本地值按 s×zoom 补偿，并按面板尺寸封顶
  const handleT = Math.max(5, Math.min(12 / (s * zoom), Math.min(container.w / s, container.h / s) / 10));

  return (
    <div
      data-scroll-scope
      style={{
        position: "absolute",
        left: container.x,
        top: container.y,
        // 外框 = 世界占位 c.w×c.h（画布坐标固定，与图片同律缩放），仅负责占位/事件/退场动画；
        // 视觉样式（边框/背景/圆角）在下方 inner 上——随 s 缩放，创建时刻屏幕边框恒为 2px 清晰
        width: container.w,
        minHeight: container.h,
        zIndex: 20,
        // 退场：淡出 + 轻微缩小（0 0 原点），与图片入场动画重叠
        transformOrigin: "0 0",
        opacity: container.exiting ? 0 : 1,
        transform: container.exiting ? "scale(0.96)" : "scale(1)",
        transition: "opacity 0.32s ease, transform 0.32s ease",
        pointerEvents: container.exiting ? "none" : "auto",
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 内层：自然尺寸排版 + 统一 scale(s)。宽度/高度按两轴实际比例铺满外框，
          逐轴拉伸时 s 不变（文字不变形），width:100%/flex 控件重排补足拉伸量。
          边框/背景/圆角在此层——随 s 缩放，创建时刻屏幕边框恒为 2px，任何视野下创建都清晰 */}
      <div
        style={{
          transform: `scale(${s})`,
          transformOrigin: "0 0",
          width: container.w / s,
          minHeight: container.h / s,
          display: "flex",
          flexDirection: "column",
          padding: 12,
          boxSizing: "border-box",
          background: isGenerating
            ? "rgba(167,139,250,0.18)"
            : "rgba(167,139,250,0.08)",
          border: isDragActive
            ? "2px dashed #c4b5fd"
            : isConnectTarget
              ? "2px solid rgba(196,181,253,0.95)"
              : "2px dashed rgba(167,139,250,0.8)",
          borderRadius: 12,
          boxShadow: isGenerating
            ? "0 0 30px rgba(167,139,250,0.5)"
            : isConnectTarget
              ? "0 0 24px rgba(196,181,253,0.55)"
              : "0 4px 20px rgba(0,0,0,0.3)",
          backdropFilter: "blur(2px)",
        }}
      >
      {/* 标题栏（拖动手柄） */}
      <div
        onMouseDown={onHeaderMouseDown}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "move",
          marginBottom: 8,
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 17, fontWeight: 600, color: "#c4b5fd" }}>
          📦 图片容器 · {modeLabel}
        </span>
        <button
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          title="删除容器"
          style={{
            // 提升到拉伸柄（zIndex 30）之上：右上角柄不遮挡关闭按钮的点击
            position: "relative",
            zIndex: 40,
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            color: "rgba(255,255,255,0.55)",
            fontSize: 18,
            lineHeight: 1,
            transition: "background 0.15s ease, color 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(248,113,113,0.2)";
            e.currentTarget.style.color = "#f87171";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "rgba(255,255,255,0.55)";
          }}
        >
          ×
        </button>
      </div>

      {/* 参考图缩略 */}
      {refNodes.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {refNodes.map((n) => (
            <div key={n.id} style={{ position: "relative" }}>
              <img
                src={n.image_url}
                alt={n.content || "ref"}
                draggable={false}
                style={{
                  width: 44,
                  height: 44,
                  objectFit: "cover",
                  borderRadius: 8,
                  border: "1px solid rgba(167,139,250,0.6)",
                }}
              />
              <button
                onClick={() => onRemoveRef(n.id)}
                onMouseDown={(e) => e.stopPropagation()}
                title="断开此参考图"
                style={{
                  position: "absolute",
                  top: -9,
                  right: -9,
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  padding: 0,
                  borderRadius: "50%",
                  background: "#f87171",
                  color: "white",
                  fontSize: 13,
                  lineHeight: 1,
                  cursor: "pointer",
                  fontWeight: 700,
                  boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
                  transition: "transform 0.12s ease, box-shadow 0.12s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "scale(1.15)";
                  e.currentTarget.style.boxShadow = "0 2px 8px rgba(248,113,113,0.6)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                  e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 宽高比（右侧：迷你形状预览 + 输出像素尺寸） */}
      <div style={{ marginTop: 12 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 14, color: "rgba(255,255,255,0.78)" }}>宽高比</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* 迷你形状预览：直观呈现最终图片的比例（替代旧版外框整体形变） */}
            <span
              style={{
                display: "inline-block",
                width:
                  aspectRatio.w >= aspectRatio.h
                    ? 34
                    : Math.round((34 * aspectRatio.w) / aspectRatio.h),
                height:
                  aspectRatio.w >= aspectRatio.h
                    ? Math.round((34 * aspectRatio.h) / aspectRatio.w)
                    : 34,
                border: "1.5px solid #a78bfa",
                borderRadius: 3,
                background: "rgba(167,139,250,0.22)",
                transition: "width 0.15s ease, height 0.15s ease",
              }}
            />
            <span
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.7)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {calcSize(container.aspect, container.resolution)}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {ASPECT_RATIOS.map((r) => (
            <button
              key={r.key}
              onClick={() => onChange({ aspect: r.key })}
              style={{ flex: 1, ...smallBtn(container.aspect === r.key) }}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      {/* 分辨率 */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,0.78)", marginBottom: 6 }}>分辨率</div>
        <div style={{ display: "flex", gap: 4 }}>
          {RESOLUTIONS.map((res) => (
            <button
              key={res}
              onClick={() => onChange({ resolution: res })}
              style={{ flex: 1, ...smallBtn(container.resolution === res) }}
            >
              {res}
            </button>
          ))}
        </div>
      </div>

      {/* 风格选择（风格库为空时隐藏） */}
      <StyleSelect experiences={experiences} value={container.experienceIds ?? []} onChange={(v) => onChange({ experienceIds: v.length ? v : undefined })} />

      {/* 描述 */}
      <textarea
        value={container.prompt}
        onChange={(e) => onChange({ prompt: e.target.value, error: undefined })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onGenerate();
          }
        }}
        placeholder={
          refNodes.length === 0
            ? "图片描述（必填）"
            : refNodes.length === 1
              ? "变体描述，留空直接生成"
              : "组合描述，留空自动融合"
        }
        style={{
          width: "100%",
          boxSizing: "border-box",
          flex: 1,
          minHeight: 232,
          marginTop: 12,
          padding: "10px 12px",
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(167,139,250,0.5)",
          borderRadius: 6,
          color: "white",
          fontSize: 17,
          lineHeight: 1.6,
          outline: "none",
          resize: "none",
          fontFamily: "inherit",
        }}
      />

      {container.error && (
        <div style={{ color: "#f87171", fontSize: 14, marginTop: 6 }}>{container.error}</div>
      )}

      {/* 生成按钮 */}
      <button
        onClick={onGenerate}
        disabled={isGenerating}
        style={{
          width: "100%",
          marginTop: 12,
          padding: "12px 0",
          background: isGenerating ? "rgba(167,139,250,0.4)" : "#a78bfa",
          color: "#1a1a2e",
          border: "none",
          borderRadius: 8,
          fontSize: 17,
          fontWeight: 700,
          cursor: isGenerating ? "not-allowed" : "pointer",
        }}
      >
        {isGenerating ? `生成中 ${Math.round(progress)}%` : "⚡ 生成"}
      </button>

      {/* 左右上下 + 四角拉伸柄：隐形热区（仅光标反馈），拖动整体等比缩放面板 */}
      {!container.exiting &&
        (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((dir) => (
          <ContainerResizeHandle key={dir} dir={dir} thickness={handleT} onDown={onHandleDown} />
        ))}

      {/* 生成中覆盖层：整个面板显示流式预览与进度；
          zIndex 45 盖过关闭按钮(40)/拉伸柄(30)，拦截一切交互——生成中不可再改风格/比例/描述等 */}
      {isGenerating && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 45,
            borderRadius: 10,
            background: container.previewUrl
              ? "rgba(0,0,0,0.25)"
              : "rgba(20,20,40,0.72)",
            backdropFilter: "blur(3px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            overflow: "hidden",
          }}
        >
          {/* 流式预览图（模糊→清晰渐进，贴合容器形状） */}
          {container.previewUrl && (
            <img
              src={container.previewUrl}
              alt="preview"
              draggable={false}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.92,
              }}
            />
          )}
          <span
            style={{
              position: "relative",
              zIndex: 1,
              fontSize: 34,
              fontWeight: 700,
              color: "#c4b5fd",
              fontVariantNumeric: "tabular-nums",
              textShadow: container.previewUrl ? "0 2px 12px rgba(0,0,0,0.9)" : "none",
            }}
          >
            {Math.round(progress)}%
          </span>
          {/* 进度条 */}
          <div
            style={{
              position: "relative",
              zIndex: 1,
              width: "72%",
              height: 8,
              background: "rgba(0,0,0,0.45)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "linear-gradient(90deg, #a78bfa, #c4b5fd)",
                borderRadius: 4,
                transition: "width 0.15s linear",
              }}
            />
          </div>
          <span
            style={{
              position: "relative",
              zIndex: 1,
              fontSize: 14,
              textShadow: container.previewUrl ? "0 1px 8px rgba(0,0,0,0.9)" : "none",
            }}
          >
            {progress >= 100
              ? "✨ 完成"
              : container.previewUrl
                ? "预览已收到，细化中..."
                : progress >= 80
                  ? "润色收尾中..."
                  : progress >= 40
                    ? "绘制细节中..."
                    : "构思画面中..."}
          </span>
        </div>
      )}
      </div>
    </div>
  );
}
