import { useEffect, useRef, useCallback, useState } from "react";
import type { CanvasState, CanvasNode } from "../types/canvas";
import { generateImageStream, uploadImageNode, undoCanvas } from "../api/agent";

// 右键菜单可触发的操作类型
export type CanvasAction =
  | { type: "compose"; nodeIds: string[]; prompt: string; size: string; x?: number; y?: number }
  | { type: "variate"; nodeId: string; prompt: string; size: string; x?: number; y?: number }
  | { type: "edit"; nodeId: string; prompt: string; size: string }
  | { type: "generate"; prompt: string; size: string; x: number; y: number }
  | { type: "delete"; nodeIds: string[] };

// 待生成图片容器（右键空白创建，接收连线作为参考图）
export type PendingContainer = {
  id: string;
  x: number;            // 世界坐标
  y: number;
  aspect: string;
  resolution: string;
  prompt: string;
  refIds: string[];     // 连线进来的参考图节点 ID
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

// 容器显示尺寸：按宽高比缩放，最长边 300
function containerDisplaySize(aspectKey: string): { w: number; h: number } {
  const ratio = ASPECT_RATIOS.find((r) => r.key === aspectKey) ?? ASPECT_RATIOS[0];
  const long = 300;
  if (ratio.w >= ratio.h) {
    return { w: long, h: Math.round((long * ratio.h) / ratio.w) };
  }
  return { w: Math.round((long * ratio.w) / ratio.h), h: long };
}

// 按比例 + 分辨率档位计算 size 字符串（如 "2048x1152"）
function calcSize(ratioKey: string, res: string): string {
  const ratio = ASPECT_RATIOS.find((r) => r.key === ratioKey) ?? ASPECT_RATIOS[0];
  const long = res === "1K" ? 1024 : res === "4K" ? 4096 : 2048;
  let w = ratio.w >= ratio.h ? long : Math.round((long * ratio.w) / ratio.h);
  let h = ratio.w >= ratio.h ? Math.round((long * ratio.h) / ratio.w) : long;
  // Seedream 要求 512~4096 且为 32 的倍数
  w = Math.max(512, Math.min(4096, Math.round(w / 32) * 32));
  h = Math.max(512, Math.min(4096, Math.round(h / 32) * 32));
  return `${w}x${h}`;
}

// 矩形（节点或容器）的边界框
type BBox = { x: number; y: number; width: number; height: number };

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
    const offset = Math.max(40, Math.abs(dx) / 2);
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
    const offset = Math.max(40, Math.abs(dy) / 2);
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
  mode: "menu" | "compose" | "variate" | "edit" | "background";
};

interface CanvasProps {
  canvasState: CanvasState | null;
  canvasId: string | null;
  busy?: boolean;
  onNodeMoved?: (nodeId: string, x: number, y: number) => void;
  onAction?: (action: CanvasAction) => boolean | void | Promise<boolean | void>;
  onCanvasUpdate?: (state: CanvasState) => void;
}

/**
 * 轻量无限画布：零依赖，CSS transform 实现 pan/zoom
 * 支持：滚轮缩放、拖拽平移、图片拖拽移动、自动适配
 * 多选：单击/Ctrl+Shift+点选、空白直接拖动框选、右键菜单直接生成
 * 平移：空格+拖动 / Shift+拖动 / 鼠标中键拖动
 */
export function Canvas({ canvasState, canvasId, busy, onNodeMoved, onAction, onCanvasUpdate }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(0.5);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const prevNodeCount = useRef(0);

  // 拖拽图片相关状态
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  // 本地位置覆盖（拖拽时即时更新，不等待 API）
  const [localOverrides, setLocalOverrides] = useState<Record<string, { x: number; y: number }>>({});

  // ===== 多选 / 框选 / 右键菜单 =====
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [promptInput, setPromptInput] = useState("");
  // 尺寸选择（宽高比 + 分辨率档位）
  const [aspect, setAspect] = useState<string>("1:1");
  const [resolution, setResolution] = useState<string>("2K");

  // ===== 待生成图片容器 + 连线 =====
  const [containers, setContainers] = useState<PendingContainer[]>([]);
  const [connecting, setConnecting] = useState<{ fromId: string; x: number; y: number; sx: number; sy: number } | null>(null);
  const [draggingContainer, setDraggingContainer] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [generatingContainerId, setGeneratingContainerId] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState(0);
  const containerSeqRef = useRef(0);

  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
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

  // 节点被删除后清理选中集合
  useEffect(() => {
    setSelectedIds((prev) => {
      const alive = new Set(nodes.map((n) => n.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [canvasState]);

  // Esc：关闭菜单 / 清空选择 / 取消连线
  // Delete/Backspace：删除选中节点
  // Ctrl+C / Cmd+C：复制选中图片到系统剪贴板（可在文件管理器粘贴为 PNG）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
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
      // Ctrl+C / Cmd+C → 复制选中图片（单选时）
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && selectedIds.size === 1) {
        const id = [...selectedIds][0];
        const node = nodes.find((n) => n.id === id);
        const url = node?.image_url;
        if (url) {
          e.preventDefault();
          (async () => {
            try {
              const blob = await (await fetch(url)).blob();
              await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            } catch {
              // 静默失败（剪贴板权限或浏览器不支持）
            }
          })();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds, nodes, onAction, canvasId, onCanvasUpdate]);

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

  // 创建待生成容器（在世界坐标 wx/wy 处，可带初始参考图）
  const createContainer = useCallback((wx: number, wy: number, refId?: string) => {
    containerSeqRef.current += 1;
    const c: PendingContainer = {
      id: `pending-${Date.now()}-${containerSeqRef.current}`,
      x: wx,
      y: wy,
      aspect: "1:1",
      resolution: "2K",
      prompt: "",
      refIds: refId ? [refId] : [],
    };
    setContainers((prev) => [...prev, c]);
  }, []);

  const updateContainer = useCallback((id: string, patch: Partial<PendingContainer>) => {
    setContainers((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeContainer = useCallback((id: string) => {
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

  // 点击菜单外部关闭
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  // 自动适配：节点数量变化时缩放到合适大小
  useEffect(() => {
    if (nodes.length === 0 || !containerRef.current) return;
    if (nodes.length === prevNodeCount.current) return;
    prevNodeCount.current = nodes.length;

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
  }, [canvasState]);

  // 滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const delta = -e.deltaY * 0.001;
    const factor = Math.exp(delta);
    const newZoom = Math.min(Math.max(zoom * factor, 0.05), 5);

    const worldX = (mouseX - pan.x) / zoom;
    const worldY = (mouseY - pan.y) / zoom;
    setPan({
      x: mouseX - worldX * newZoom,
      y: mouseY - worldY * newZoom,
    });
    setZoom(newZoom);
  }, [zoom, pan]);

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
      setLocalOverrides((prev) => ({
        ...prev,
        [draggingNode]: {
          x: worldX - dragOffset.x,
          y: worldY - dragOffset.y,
        },
      }));
    } else if (isPanning) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setPan({
        x: panStart.current.panX + dx,
        y: panStart.current.panY + dy,
      });
    }
  }, [connecting, draggingContainer, draggingNode, isPanning, pan, zoom, dragOffset, screenToWorld]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // 连线结束：判断是否命中容器（命中范围覆盖容器整个可视区域）
    if (connecting) {
      const w = screenToWorld(e.clientX, e.clientY);
      const hit = containers.find((c) => {
        const size = containerDisplaySize(c.aspect);
        return (
          w.x >= c.x &&
          w.x <= c.x + size.w + 24 &&
          w.y >= c.y &&
          w.y <= c.y + size.h + 280
        );
      });
      if (hit && !hit.refIds.includes(connecting.fromId)) {
        // 命中容器：添加参考图
        updateContainer(hit.id, { refIds: [...hit.refIds, connecting.fromId], error: undefined });
      } else if (!hit) {
        // 空白处松手：原地新建容器，并自动连上该参考图
        createContainer(w.x - 160, w.y - 120, connecting.fromId);
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
        const pos = localOverrides[draggingNode];
        if (pos && onNodeMoved) {
          onNodeMoved(draggingNode, pos.x, pos.y);
        }
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
      // 空白 click（无位移）：清空选择
      const down = backgroundDownRef.current;
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 4) {
        setSelectedIds(new Set());
        setMenu(null);
      }
      backgroundDownRef.current = null;
      setIsPanning(false);
    }
  }, [marquee, draggingNode, localOverrides, onNodeMoved, isPanning, pan, zoom, nodes, connecting, containers, updateContainer, screenToWorld, draggingContainer, createContainer]);

  // 图片节点拖拽开始（记录起点用于 click/drag 判定）
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, node: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

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
    setDraggingNode(node.id);
  }, [pan, zoom]);

  // 图片右键：选中（若未选中）并打开菜单
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
    setPromptInput("");
    setMenu((prev) => (prev ? { ...prev, mode } : null));
  }, []);

  const handleExecute = useCallback(() => {
    if (!onAction || !menu) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const prompt = promptInput.trim();
    const size = calcSize(aspect, resolution);

    if (menu.mode === "compose" && ids.length >= 2) {
      onAction({ type: "compose", nodeIds: ids, prompt, size });
    } else if (menu.mode === "variate" && ids.length === 1) {
      onAction({ type: "variate", nodeId: ids[0], prompt, size });
    } else if (menu.mode === "edit" && ids.length === 1 && prompt) {
      onAction({ type: "edit", nodeId: ids[0], prompt, size });
    } else {
      return;
    }
    setMenu(null);
    setPromptInput("");
  }, [onAction, menu, selectedIds, promptInput, aspect, resolution]);

  const handleDelete = useCallback(() => {
    if (!onAction || selectedIds.size === 0) return;
    onAction({ type: "delete", nodeIds: [...selectedIds] });
    setMenu(null);
  }, [onAction, selectedIds]);

  // 复制选中图片到系统剪贴板（可在文件管理器 Ctrl+V 粘贴为 PNG 文件）
  const handleCopyImage = useCallback(async () => {
    const id = [...selectedIds][0];
    const node = nodes.find((n) => n.id === id);
    setMenu(null);
    if (!node?.image_url) return;
    try {
      const blob = await (await fetch(node.image_url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      // 浏览器不支持或剪贴板被拒：静默失败
    }
  }, [selectedIds, nodes]);

  // 另存为：触发浏览器下载
  const handleSaveImage = useCallback(() => {
    const id = [...selectedIds][0];
    const node = nodes.find((n) => n.id === id);
    setMenu(null);
    if (!node?.image_url) return;
    const a = document.createElement("a");
    a.href = node.image_url;
    a.download = `canvas-${node.id.slice(0, 8)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [selectedIds, nodes]);

  // 空白右键：打开「新建容器」菜单
  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, mode: "background" });
  }, []);

  // 菜单点击「新建图片容器」：在右键位置（转世界坐标）创建
  const handleCreateContainer = useCallback(() => {
    if (!menu) return;
    const w = screenToWorld(menu.x, menu.y);
    // 容器左上角对齐点击点，稍微上移让标题可见
    createContainer(w.x, w.y - 20);
    setMenu(null);
  }, [menu, screenToWorld, createContainer]);

  // 容器生成：0 参考图文生图 / 1 参考图变体 / 多参考图组合（SSE 流式 + 真实预览图）
  const handleContainerGenerate = useCallback(
    async (c: PendingContainer) => {
      if (!canvasId) return;
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
      onWheel={handleWheel}
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
                    />
                    <circle cx={ep.x1} cy={ep.y1} r={5} fill="#6366f1" />
                    <circle cx={ep.x2} cy={ep.y2} r={5} fill="#6366f1" />
                  </g>
                );
              })
            )}

          {/* 容器的待生成参考连线（虚线） */}
          {containers.map((c) => {
            const size = containerDisplaySize(c.aspect);
            const tgtRect: BBox = { x: c.x, y: c.y, width: size.w, height: size.h };
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
                  />
                  <circle cx={ep.x1} cy={ep.y1} r={4} fill="#a78bfa" />
                </g>
              );
            });
          })}

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
                const offset = Math.max(40, Math.abs(dx) / 2);
                const dir = dx >= 0 ? 1 : -1;
                cx1 = x1 + dir * offset;
                cy1 = y1;
                cx2 = x2 - dir * offset;
                cy2 = y2;
              } else {
                const offset = Math.max(40, Math.abs(dy) / 2);
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
            isLinked={!!(node.source_ids && node.source_ids.length > 0)}
            isSelected={selectedIds.has(node.id)}
            showPorts={hoveredNode === node.id || (connecting?.fromId === node.id)}
            onPortMouseDown={(e, portIdx) => handlePortMouseDown(e, node, portIdx)}
            onMouseDown={(e) => handleNodeMouseDown(e, node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
            onContextMenu={(e) => handleNodeContextMenu(e, node)}
          />
        ))}

        {/* 待生成图片容器 */}
        {containers.map((c) => (
          <PendingContainerNode
            key={c.id}
            container={c}
            nodes={nodes}
            isGenerating={generatingContainerId === c.id}
            isDragActive={draggingContainer?.id === c.id}
            isConnectTarget={!!connecting}
            progress={generatingContainerId === c.id ? genProgress : 0}
            onHeaderMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              const w = screenToWorld(e.clientX, e.clientY);
              setDraggingContainer({ id: c.id, offsetX: w.x - c.x, offsetY: w.y - c.y });
            }}
            onChange={(patch) => updateContainer(c.id, patch)}
            onRemoveRef={(rid) =>
              updateContainer(c.id, { refIds: c.refIds.filter((r) => r !== rid) })
            }
            onRemove={() => removeContainer(c.id)}
            onGenerate={() => handleContainerGenerate(c)}
          />
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

      {/* 右键菜单 */}
      {menu && (
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
          onMenuAction={handleMenuAction}
          onExecute={handleExecute}
          onDelete={handleDelete}
          onCopyImage={handleCopyImage}
          onSaveImage={handleSaveImage}
          onCreateContainer={handleCreateContainer}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 选中数量提示 */}
      {selectedCount > 0 && !menu && !connecting && !busy && (
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

      {/* 缩放指示器 */}
      <div
        style={{
          position: "absolute",
          bottom: 80,
          right: 16,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        {Math.round(zoom * 100)}%
      </div>
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
  onMenuAction,
  onExecute,
  onDelete,
  onCopyImage,
  onSaveImage,
  onCreateContainer,
  onClose,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  mode: "menu" | "compose" | "variate" | "edit" | "background";
  selectedCount: number;
  selectedNodeContent: string;
  promptInput: string;
  onPromptChange: (v: string) => void;
  aspect: string;
  resolution: string;
  onAspectChange: (v: string) => void;
  onResolutionChange: (v: string) => void;
  onMenuAction: (mode: "compose" | "variate" | "edit") => void;
  onExecute: () => void;
  onDelete: () => void;
  onCopyImage: () => void;
  onSaveImage: () => void;
  onCreateContainer: () => void;
  onClose: () => void;
}) => {
  const MENU_W = 260;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const menuH = mode === "menu"
    ? (selectedCount === 1 && selectedNodeContent ? 320 : 200)
    : 390;
  const top = Math.min(y, window.innerHeight - menuH);

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

  // 输入框模式（组合 / 变体 / 编辑）
  const inputPlaceholder =
    mode === "compose"
      ? "组合描述，留空直接生成"
      : mode === "variate"
        ? "变体描述，留空直接生成"
        : "编辑描述（必填），如：把背景改成星空";

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
      {/* 标题 */}
      <div
        style={{
          padding: "6px 14px 8px",
          fontSize: 11,
          color: "rgba(255,255,255,0.45)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 4,
        }}
      >
        {mode === "menu"
          ? `已选中 ${selectedCount} 张图片`
          : mode === "background"
            ? "画布空白处"
            : "描述（可选）"}
      </div>

      {/* 选中图片的生成提示词（详情） */}
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
          <input
            autoFocus
            value={promptInput}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onExecute();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={inputPlaceholder}
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

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={onExecute}
              disabled={mode === "edit" && !promptInput.trim()}
              style={{
                flex: 1,
                padding: "7px 0",
                background: mode === "edit" && !promptInput.trim() ? "rgba(99,102,241,0.3)" : "#6366f1",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                cursor: mode === "edit" && !promptInput.trim() ? "not-allowed" : "pointer",
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
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
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
 * 待生成图片容器：规定宽高，接收参考图连线，生成后原地变真实图片
 */
function PendingContainerNode({
  container,
  nodes,
  isGenerating,
  isDragActive,
  isConnectTarget,
  progress,
  onHeaderMouseDown,
  onChange,
  onRemoveRef,
  onRemove,
  onGenerate,
}: {
  container: PendingContainer;
  nodes: CanvasNode[];
  isGenerating: boolean;
  isDragActive: boolean;
  isConnectTarget: boolean;
  progress: number;
  onHeaderMouseDown: (e: React.MouseEvent) => void;
  onChange: (patch: Partial<PendingContainer>) => void;
  onRemoveRef: (nodeId: string) => void;
  onRemove: () => void;
  onGenerate: () => void;
}) {
  const size = containerDisplaySize(container.aspect);
  const refNodes = container.refIds
    .map((rid) => nodes.find((n) => n.id === rid))
    .filter((n): n is CanvasNode => !!n);
  const modeLabel =
    refNodes.length === 0
      ? "文生图"
      : refNodes.length === 1
        ? "图生图 · 1 参考图"
        : `多图组合 · ${refNodes.length} 参考图`;

  const smallBtn = (active: boolean): React.CSSProperties => ({
    padding: "4px 0",
    background: active ? "#a78bfa" : "rgba(255,255,255,0.08)",
    color: active ? "#1a1a2e" : "rgba(255,255,255,0.6)",
    border: "none",
    borderRadius: 5,
    fontSize: 10,
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
  });

  return (
    <div
      style={{
        position: "absolute",
        left: container.x,
        top: container.y,
        width: size.w + 24, // 内容区 + padding
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
        padding: 12,
        zIndex: 20,
        backdropFilter: "blur(2px)",
        // 退场：淡出 + 轻微缩小，与图片入场动画重叠
        opacity: container.exiting ? 0 : 1,
        transform: container.exiting ? "scale(0.95)" : "scale(1)",
        transformOrigin: "center center",
        transition: "opacity 0.32s ease, transform 0.32s ease",
        pointerEvents: container.exiting ? "none" : "auto",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
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
        <span style={{ fontSize: 11, fontWeight: 600, color: "#c4b5fd" }}>
          📦 图片容器 · {modeLabel}
        </span>
        <button
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          title="删除容器"
          style={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            color: "rgba(255,255,255,0.5)",
            fontSize: 16,
            lineHeight: 1,
            transition: "background 0.15s ease, color 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(248,113,113,0.2)";
            e.currentTarget.style.color = "#f87171";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "rgba(255,255,255,0.5)";
          }}
        >
          ×
        </button>
      </div>

      {/* 尺寸预览框（按宽高比）：生成时显示进度/流式预览图 */}
      <div
        style={{
          position: "relative",
          width: size.w,
          height: size.h,
          border: "1px dashed rgba(196,181,253,0.5)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(255,255,255,0.35)",
          fontSize: 11,
          gap: 6,
          background: "rgba(0,0,0,0.15)",
          overflow: "hidden",
        }}
      >
        {/* 流式预览图（模糊→清晰渐进） */}
        {isGenerating && container.previewUrl && (
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
        {isGenerating ? (
          <>
            <span
              style={{
                position: "relative",
                zIndex: 1,
                fontSize: 30,
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
                height: 6,
                background: "rgba(0,0,0,0.45)",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #a78bfa, #c4b5fd)",
                  borderRadius: 3,
                  transition: "width 0.15s linear",
                }}
              />
            </div>
            <span
              style={{
                position: "relative",
                zIndex: 1,
                fontSize: 10,
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
          </>
        ) : (
          <>
            <span style={{ fontSize: 22 }}>🖼️</span>
            <span>{calcSize(container.aspect, container.resolution)}</span>
            <span style={{ fontSize: 10 }}>
              {refNodes.length > 0 ? "参考图已连线" : "等待生成"}
            </span>
          </>
        )}
      </div>

      {/* 参考图缩略 */}
      {refNodes.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {refNodes.map((n) => (
            <div key={n.id} style={{ position: "relative" }}>
              <img
                src={n.image_url}
                alt={n.content || "ref"}
                draggable={false}
                style={{
                  width: 36,
                  height: 36,
                  objectFit: "cover",
                  borderRadius: 6,
                  border: "1px solid rgba(167,139,250,0.6)",
                }}
              />
              <button
                onClick={() => onRemoveRef(n.id)}
                onMouseDown={(e) => e.stopPropagation()}
                title="断开此参考图"
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  width: 22,
                  height: 22,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  padding: 0,
                  borderRadius: "50%",
                  background: "#f87171",
                  color: "white",
                  fontSize: 12,
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

      {/* 宽高比 */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", marginBottom: 3 }}>宽高比</div>
        <div style={{ display: "flex", gap: 3 }}>
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
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", marginBottom: 3 }}>分辨率</div>
        <div style={{ display: "flex", gap: 3 }}>
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
        rows={2}
        style={{
          width: "100%",
          boxSizing: "border-box",
          marginTop: 8,
          padding: "6px 8px",
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(167,139,250,0.5)",
          borderRadius: 6,
          color: "white",
          fontSize: 12,
          outline: "none",
          resize: "none",
          fontFamily: "inherit",
        }}
      />

      {container.error && (
        <div style={{ color: "#f87171", fontSize: 10, marginTop: 4 }}>{container.error}</div>
      )}

      {/* 生成按钮 */}
      <button
        onClick={onGenerate}
        disabled={isGenerating}
        style={{
          width: "100%",
          marginTop: 8,
          padding: "8px 0",
          background: isGenerating ? "rgba(167,139,250,0.4)" : "#a78bfa",
          color: "#1a1a2e",
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          cursor: isGenerating ? "not-allowed" : "pointer",
        }}
      >
        {isGenerating ? `生成中 ${Math.round(progress)}%` : "⚡ 生成"}
      </button>
    </div>
  );
}
