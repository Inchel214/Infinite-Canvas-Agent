/**
 * 蒙版编辑器组件：用于局部编辑（Inpainting）
 * 用户在原图上标记要修改的区域（画笔/橡皮/套索/矩形/魔棒），输入修改描述
 * mask 导出为黑底白色 PNG（API 要求白=要修改的区域），支持边缘羽化
 *
 * 架构：双 canvas 分层
 *   - logicMaskRef（离屏，白色实心笔画）= 真相源，用于导出/撤销/边缘检测
 *   - displayCanvasRef（可视层）= 按显示模式渲染：叠加（紫色半透明）/ 轮廓（只描边不遮挡）
 */
import { useState, useRef, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { addExperience, getExperience, listExperiences } from "../api/agent";
import type { ExperienceMeta } from "../api/agent";
import type { EditorShortcutConfig, ShortcutConflict, ShortcutScope } from "./canvas/types";
import { formatShortcut, matchesShortcut } from "./canvas/state/canvasShortcuts";
import {
  ASPECT_RATIOS,
  RESOLUTIONS,
} from "./canvas/constants";
import {
  closestAspectKey,
  closestResolutionKey,
  calcSize,
} from "./canvas/utils/aspect";

interface MaskEditorProps {
  imageUrl: string;
  width: number;   // 原图世界尺寸宽
  height: number;  // 原图世界尺寸高
  experiences: ExperienceMeta[];
  // 从编辑面板带入的初始值：避免用户在两级界面重复填写
  initialPrompt?: string;
  initialAspect?: string;
  initialResolution?: string;
  initialStyleIds?: string[];
  // 快捷键配置（与画布共用同一份存储）
  shortcutBindings: EditorShortcutConfig;
  conflicts: ShortcutConflict[];
  onUpdateShortcut: (
    action: keyof EditorShortcutConfig,
    key: string,
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ) => void;
  onResetShortcuts: (scope: ShortcutScope | "all") => void;
  onConfirm: (mask: string, prompt: string, size: string, experienceIds?: string[]) => void;
  onCancel: () => void;
}

/** 局部编辑器内可自定义的动作（用于快捷键提示浮层） */
const EDITOR_ACTIONS: Array<{ action: keyof EditorShortcutConfig; label: string }> = [
  { action: "brush", label: "画笔" },
  { action: "eraser", label: "橡皮擦" },
  { action: "lasso", label: "套索" },
  { action: "rect", label: "矩形框选" },
  { action: "wand", label: "魔棒" },
  { action: "invert", label: "反选" },
  { action: "brushSmaller", label: "缩小笔刷" },
  { action: "brushLarger", label: "放大笔刷" },
  { action: "confirm", label: "确认编辑" },
  { action: "help", label: "快捷键提示" },
];

type Tool = "brush" | "eraser" | "lasso" | "rect" | "wand";
type ViewMode = "overlay" | "outline";

const MASK_RGB = { r: 167, g: 139, b: 250 }; // 品牌紫
const MAX_UNDO = 20;

/** 场景预设：一键预填描述（换背景会先自动反选：涂主体 → 反转 → 改背景） */
const PRESETS: { key: string; text: string; invert: boolean }[] = [
  { key: "换背景", text: "把背景换成", invert: true },
  { key: "去物体", text: "移除选中区域，用周围背景自然填充", invert: false },
  { key: "换装", text: "把选中区域的服装换成", invert: false },
  { key: "换色", text: "把选中区域的颜色改为", invert: false },
];

/** 自定义预设按钮样式（与内置预设区分，虚线弱化） */
const customPresetStyle: CSSProperties = {
  padding: "6px 8px",
  fontSize: 12,
  border: "1px dashed rgba(255,255,255,0.25)",
  borderRadius: 6,
  cursor: "pointer",
  background: "transparent",
  color: "rgba(255,255,255,0.7)",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function MaskEditor({ imageUrl, width, height, experiences, initialPrompt, initialAspect, initialResolution, initialStyleIds, shortcutBindings, conflicts, onUpdateShortcut, onResetShortcuts, onConfirm, onCancel }: MaskEditorProps) {
  const [tool, setTool] = useState<Tool>("brush");
  const [showHelp, setShowHelp] = useState(false);
  const [recordingAction, setRecordingAction] = useState<keyof EditorShortcutConfig | null>(null);
  const [brushSize, setBrushSize] = useState(30);
  const [wandTol, setWandTol] = useState(32);
  const [feather, setFeather] = useState(0);
  const [showFeatherHelp, setShowFeatherHelp] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("overlay");
  const [isLoading, setIsLoading] = useState(true);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [aspect, setAspect] = useState(() => (initialAspect !== undefined ? initialAspect : closestAspectKey(width, height)));
  const [resolution, setResolution] = useState(initialResolution ?? "2K");
  const [styleIds, setStyleIds] = useState<string[]>(initialStyleIds ?? []);
  const [styleOpen, setStyleOpen] = useState(false);
  // 自定义预设：来自提示词库（kind=preset），与内置预设并列
  const [customPresets, setCustomPresets] = useState<ExperienceMeta[]>([]);
  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetError, setPresetError] = useState("");
  const [viewOriginal, setViewOriginal] = useState(false);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const [maskVersion, setMaskVersion] = useState(0); // 触发 hasMask 重算
  const [wandFailed, setWandFailed] = useState(false);
  // 图片是否允许读取像素（CORS 加载成功才可读，否则 canvas 被污染，魔棒不可用）
  const [pixelsReadable, setPixelsReadable] = useState(true);

  const baseCanvasRef = useRef<HTMLCanvasElement>(null);      // 原图层
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);   // 可视层（接收鼠标事件）
  const logicMaskRef = useRef<HTMLCanvasElement | null>(null); // 离屏逻辑 mask（白色）
  const tintedRef = useRef<HTMLCanvasElement | null>(null);    // 紫色染色版（叠加模式用）
  const wandSrcRef = useRef<HTMLCanvasElement | null>(null);   // 原图像素源（natural 尺寸，魔棒用）
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const styleBtnRef = useRef<HTMLButtonElement>(null);
  const styleListRef = useRef<HTMLDivElement>(null);

  // 变换（缩放/平移）：绕开 React 渲染，直接操作 DOM，保证拖拽流畅
  const transformRef = useRef({ s: 1, tx: 0, ty: 0 });
  // 撤销/重做栈：存 logicMask 的 dataURL
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  // 绘制会话状态
  const drawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const lassoRef = useRef<{ x: number; y: number }[]>([]);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const panningRef = useRef(false);
  const spaceRef = useRef(false);
  const panStartRef = useRef({ px: 0, py: 0, tx: 0, ty: 0 });
  const viewModeRef = useRef<ViewMode>("overlay");
  viewModeRef.current = viewMode;

  // ===== 视图变换 =====
  const applyTransform = useCallback(() => {
    const w = wrapperRef.current;
    if (!w) return;
    const t = transformRef.current;
    w.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.s})`;
  }, []);

  const resetView = useCallback(() => {
    const stage = stageRef.current;
    const base = baseCanvasRef.current;
    if (!stage || !base) return;
    transformRef.current = {
      s: 1,
      tx: (stage.clientWidth - base.width) / 2,
      ty: (stage.clientHeight - base.height) / 2,
    };
    applyTransform();
  }, [applyTransform]);

  // 滚轮缩放（以鼠标为中心）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = transformRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const s = Math.min(8, Math.max(0.4, t.s * factor));
      const k = s / t.s;
      transformRef.current = { s, tx: mx - (mx - t.tx) * k, ty: my - (my - t.ty) * k };
      applyTransform();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyTransform]);

  // ===== 图片加载与画布初始化 =====
  // 图片加载：
  // 优先用 fetch 取回二进制 → blob URL（同源）→ 画到 canvas 不会被跨域污染，
  // 保证魔棒能读像素；fetch 失败再退化为直接 <img> 加载（能显示能涂抹，魔棒将自动禁用）。
  useEffect(() => {
    let cancelled = false;

    const loadViaBlob = async (): Promise<HTMLImageElement> => {
      // cache: "reload" 绕过可能不含 CORS 头的旧缓存（后端图片有 1 天强缓存），
      // 否则会把缓存的图片响应判为跨域失败，导致魔棒被误判不可用
      const resp = await fetch(imageUrl, { mode: "cors", cache: "reload" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("blob decode failed"));
          i.src = objUrl;
        });
      } finally {
        URL.revokeObjectURL(objUrl); // 已解码完成，释放 URL 不影响后续绘制
      }
    };

    const loadDirect = () =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("image load failed"));
        i.src = imageUrl;
      });

    (async () => {
      let img: HTMLImageElement;
      try {
        img = await loadViaBlob();
      } catch {
        console.warn("[MaskEditor] blob 加载失败，降级为直接加载（可能需要禁用魔棒）");
        img = await loadDirect();
      }
      if (cancelled) return;
      imageRef.current = img;
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
      setResolution(closestResolutionKey(longEdge));
      setIsLoading(false);
    })().catch(() => {
      if (!cancelled) {
        console.error("Failed to load image");
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const getScale = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return 1;
    const maxW = stage.clientWidth - 24;
    const maxH = stage.clientHeight - 24;
    return Math.min(maxW / width, maxH / height, 1);
  }, [width, height]);

  useEffect(() => {
    const base = baseCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!base || !display || !imageRef.current || isLoading) return;

    const scale = getScale();
    const displayW = Math.max(1, Math.round(width * scale));
    const displayH = Math.max(1, Math.round(height * scale));

    base.width = displayW;
    base.height = displayH;
    display.width = displayW;
    display.height = displayH;

    const bctx = base.getContext("2d");
    if (bctx) {
      bctx.clearRect(0, 0, displayW, displayH);
      bctx.drawImage(imageRef.current, 0, 0, displayW, displayH);
    }

    // 离屏逻辑 mask（白色实心）
    if (!logicMaskRef.current) logicMaskRef.current = document.createElement("canvas");
    logicMaskRef.current.width = displayW;
    logicMaskRef.current.height = displayH;

    // 染色版
    if (!tintedRef.current) tintedRef.current = document.createElement("canvas");
    tintedRef.current.width = displayW;
    tintedRef.current.height = displayH;

    // 魔棒像素源（原图 natural 尺寸）
    const src = document.createElement("canvas");
    src.width = imageRef.current.naturalWidth;
    src.height = imageRef.current.naturalHeight;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    if (sctx) {
      sctx.drawImage(imageRef.current, 0, 0);
      wandSrcRef.current = src;
      // 真实探测像素是否可读（blob 加载时必然可读；直接加载跨域图会抛 SecurityError）
      try {
        sctx.getImageData(0, 0, 1, 1);
        setPixelsReadable(true);
      } catch {
        setPixelsReadable(false);
      }
    }

    resetView();
    renderDisplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, width, height, getScale, resetView]);

  // ===== 显示渲染 =====
  /** 把 logicMask 染色成紫色版本缓存到 tintedRef */
  const updateTinted = useCallback(() => {
    const mask = logicMaskRef.current;
    const tinted = tintedRef.current;
    if (!mask || !tinted) return;
    const ctx = tinted.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, tinted.width, tinted.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = `rgb(${MASK_RGB.r}, ${MASK_RGB.g}, ${MASK_RGB.b})`;
    ctx.fillRect(0, 0, tinted.width, tinted.height);
    ctx.globalCompositeOperation = "source-over";
  }, []);

  /** 按当前显示模式把 logicMask 渲染到 display canvas */
  const renderDisplay = useCallback(() => {
    const display = displayCanvasRef.current;
    const mask = logicMaskRef.current;
    if (!display || !mask) return;
    const ctx = display.getContext("2d");
    if (!ctx) return;
    const w = display.width;
    const h = display.height;
    ctx.clearRect(0, 0, w, h);

    if (viewModeRef.current === "overlay") {
      // 叠加模式：紫色半透明填充
      const tinted = tintedRef.current;
      if (!tinted) return;
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tinted, 0, 0);
      ctx.restore();
    } else {
      // 轮廓模式：边缘不透明描边 + 内部极淡填充，原图细节无遮挡
      const mctx = mask.getContext("2d");
      if (!mctx) return;
      const src = mctx.getImageData(0, 0, w, h);
      const out = ctx.createImageData(w, h);
      const a = src.data;
      const o = out.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (a[i + 3] === 0) continue;
          const isEdge =
            x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
            a[i - 4 + 3] === 0 || a[i + 4 + 3] === 0 ||
            a[i - w * 4 + 3] === 0 || a[i + w * 4 + 3] === 0;
          o[i] = MASK_RGB.r;
          o[i + 1] = MASK_RGB.g;
          o[i + 2] = MASK_RGB.b;
          o[i + 3] = isEdge ? 255 : 26;
        }
      }
      ctx.putImageData(out, 0, 0);
    }
  }, []);

  // 显示模式切换时重渲染
  useEffect(() => {
    renderDisplay();
  }, [viewMode, renderDisplay]);

  // ===== 撤销 / 重做 =====
  const pushUndo = useCallback(() => {
    const mask = logicMaskRef.current;
    if (!mask) return;
    undoRef.current.push(mask.toDataURL());
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
    setUndoLen(undoRef.current.length);
    setRedoLen(0);
  }, []);

  const restoreMask = useCallback((dataUrl: string) => {
    const mask = logicMaskRef.current;
    if (!mask) return;
    const img = new Image();
    img.onload = () => {
      const ctx = mask.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, mask.width, mask.height);
      ctx.drawImage(img, 0, 0);
      updateTinted();
      renderDisplay();
      setMaskVersion((v) => v + 1);
    };
    img.src = dataUrl;
  }, [updateTinted, renderDisplay]);

  const undo = useCallback(() => {
    const mask = logicMaskRef.current;
    if (!mask || undoRef.current.length === 0) return;
    redoRef.current.push(mask.toDataURL());
    const url = undoRef.current.pop()!;
    setUndoLen(undoRef.current.length);
    setRedoLen(redoRef.current.length);
    restoreMask(url);
  }, [restoreMask]);

  const redo = useCallback(() => {
    const mask = logicMaskRef.current;
    if (!mask || redoRef.current.length === 0) return;
    undoRef.current.push(mask.toDataURL());
    const url = redoRef.current.pop()!;
    setUndoLen(undoRef.current.length);
    setRedoLen(redoRef.current.length);
    restoreMask(url);
  }, [restoreMask]);

  /** 一次绘制操作结束（笔画/套索/矩形/魔棒/反选后）：刷新显示 + 触发 hasMask 重算 */
  const commitMask = useCallback(() => {
    updateTinted();
    renderDisplay();
    setMaskVersion((v) => v + 1);
  }, [updateTinted, renderDisplay]);

  // ===== 坐标换算（getBoundingClientRect 已含 transform，自动适配缩放） =====
  const getPos = (e: { clientX: number; clientY: number }) => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  // ===== 画笔/橡皮：连续笔迹（lineTo 插值，圆头线帽） =====
  const strokeTo = (pos: { x: number; y: number }) => {
    const mask = logicMaskRef.current;
    const display = displayCanvasRef.current;
    if (!mask || !display) return;
    const last = lastPosRef.current || pos;
    const erase = tool === "eraser";

    const drawSeg = (ctx: CanvasRenderingContext2D, color: string, alpha: number) => {
      ctx.save();
      ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      ctx.restore();
    };

    // 真相源：白色不透明
    const mctx = mask.getContext("2d");
    if (mctx) drawSeg(mctx, "#ffffff", 1);
    // 可视层实时预览：叠加模式下直接增量画；轮廓模式等 stroke 结束后统一渲染
    if (viewModeRef.current === "overlay") {
      const dctx = display.getContext("2d");
      if (dctx) drawSeg(dctx, `rgb(${MASK_RGB.r}, ${MASK_RGB.g}, ${MASK_RGB.b})`, erase ? 1 : 0.45);
    }
    lastPosRef.current = pos;
  };

  // ===== 魔棒：扫描线 flood fill，选中与点击点颜色相近的连通区域 =====
  const floodFillSelect = (pos: { x: number; y: number }) => {
    const src = wandSrcRef.current;
    const mask = logicMaskRef.current;
    if (!src || !mask) return;
    const W = src.width;
    const H = src.height;
    const sctx = src.getContext("2d");
    if (!sctx) return;

    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, W, H).data;
    } catch {
      // 跨域污染等极端情况：提示后退回画笔
      setWandFailed(true);
      setTool("brush");
      return;
    }

    // 显示坐标 → 原图 natural 坐标
    const sx = Math.min(W - 1, Math.max(0, Math.floor((pos.x / mask.width) * W)));
    const sy = Math.min(H - 1, Math.max(0, Math.floor((pos.y / mask.height) * H)));
    const startIdx = (sy * W + sx) * 4;
    const tr = data[startIdx];
    const tg = data[startIdx + 1];
    const tb = data[startIdx + 2];
    const tol = wandTol;

    const matches = (i: number) =>
      Math.abs(data[i] - tr) <= tol &&
      Math.abs(data[i + 1] - tg) <= tol &&
      Math.abs(data[i + 2] - tb) <= tol;

    const selected = new Uint8Array(W * H);
    const stack: number[] = [sx, sy];
    while (stack.length >= 2) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      // 向左扫描到边界
      while (x >= 0 && !selected[y * W + x] && matches((y * W + x) * 4)) x--;
      x++;
      let spanUp = false;
      let spanDown = false;
      // 向右扫描，顺带检查上下行
      while (x < W && !selected[y * W + x] && matches((y * W + x) * 4)) {
        selected[y * W + x] = 1;
        if (y > 0) {
          const up = !selected[(y - 1) * W + x] && matches(((y - 1) * W + x) * 4);
          if (up && !spanUp) { stack.push(x, y - 1); spanUp = true; }
          else if (!up) spanUp = false;
        }
        if (y < H - 1) {
          const down = !selected[(y + 1) * W + x] && matches(((y + 1) * W + x) * 4);
          if (down && !spanDown) { stack.push(x, y + 1); spanDown = true; }
          else if (!down) spanDown = false;
        }
        x++;
      }
    }

    // 选区 → 白色 ImageData（natural 尺寸）→ 缩放到 logicMask 尺寸
    const selCanvas = document.createElement("canvas");
    selCanvas.width = W;
    selCanvas.height = H;
    const selCtx = selCanvas.getContext("2d");
    if (!selCtx) return;
    const out = selCtx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      if (!selected[i]) continue;
      const p = i * 4;
      out.data[p] = 255;
      out.data[p + 1] = 255;
      out.data[p + 2] = 255;
      out.data[p + 3] = 255;
    }
    selCtx.putImageData(out, 0, 0);

    const mctx = mask.getContext("2d");
    if (!mctx) return;
    mctx.save();
    mctx.globalCompositeOperation = "source-over";
    mctx.drawImage(selCanvas, 0, 0, mask.width, mask.height);
    mctx.restore();
  };

  // ===== 反选：mask alpha 反转（涂主体 → 反选 → 改背景） =====
  const invertMask = () => {
    const mask = logicMaskRef.current;
    if (!mask) return;
    const ctx = mask.getContext("2d");
    if (!ctx) return;
    pushUndo();
    const img = ctx.getImageData(0, 0, mask.width, mask.height);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      d[i] = 255 - d[i];
    }
    ctx.putImageData(img, 0, 0);
    commitMask();
  };

  // ===== 鼠标事件 =====
  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 平移：按住空格 + 左键，或中键
    if (spaceRef.current || e.button === 1) {
      panningRef.current = true;
      panStartRef.current = {
        px: e.clientX,
        py: e.clientY,
        tx: transformRef.current.tx,
        ty: transformRef.current.ty,
      };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const pos = getPos(e);

    if (tool === "brush" || tool === "eraser") {
      pushUndo();
      drawingRef.current = true;
      lastPosRef.current = pos;
      strokeTo(pos); // 单点也要画一个点
    } else if (tool === "lasso") {
      pushUndo();
      drawingRef.current = true;
      lassoRef.current = [pos];
    } else if (tool === "rect") {
      pushUndo();
      drawingRef.current = true;
      rectStartRef.current = pos;
    } else if (tool === "wand") {
      pushUndo();
      floodFillSelect(pos);
      commitMask();
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (panningRef.current) {
      const t = transformRef.current;
      transformRef.current = {
        s: t.s,
        tx: panStartRef.current.tx + (e.clientX - panStartRef.current.px),
        ty: panStartRef.current.ty + (e.clientY - panStartRef.current.py),
      };
      applyTransform();
      return;
    }
    if (!drawingRef.current) return;
    const pos = getPos(e);

    if (tool === "brush" || tool === "eraser") {
      strokeTo(pos);
    } else if (tool === "lasso") {
      lassoRef.current.push(pos);
      renderLassoPreview();
    } else if (tool === "rect") {
      renderRectPreview(pos);
    }
  };

  /** 套索预览：display 上重渲染 + 路径描边 */
  const renderLassoPreview = () => {
    const display = displayCanvasRef.current;
    if (!display) return;
    renderDisplay();
    const ctx = display.getContext("2d");
    const path = lassoRef.current;
    if (!ctx || path.length < 2) return;
    ctx.save();
    ctx.strokeStyle = `rgb(${MASK_RGB.r}, ${MASK_RGB.g}, ${MASK_RGB.b})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };

  /** 矩形预览 */
  const renderRectPreview = (pos: { x: number; y: number }) => {
    const display = displayCanvasRef.current;
    const start = rectStartRef.current;
    if (!display || !start) return;
    renderDisplay();
    const ctx = display.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = `rgb(${MASK_RGB.r}, ${MASK_RGB.g}, ${MASK_RGB.b})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(
      Math.min(start.x, pos.x),
      Math.min(start.y, pos.y),
      Math.abs(pos.x - start.x),
      Math.abs(pos.y - start.y),
    );
    ctx.restore();
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (panningRef.current) {
      panningRef.current = false;
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const pos = getPos(e);
    const mask = logicMaskRef.current;
    const mctx = mask?.getContext("2d");

    if (tool === "lasso" && mctx && lassoRef.current.length >= 2) {
      // 闭合路径填充白色
      const path = lassoRef.current;
      mctx.save();
      mctx.fillStyle = "#ffffff";
      mctx.beginPath();
      mctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) mctx.lineTo(path[i].x, path[i].y);
      mctx.closePath();
      mctx.fill();
      mctx.restore();
      lassoRef.current = [];
      commitMask();
    } else if (tool === "rect" && mctx && rectStartRef.current) {
      const start = rectStartRef.current;
      mctx.save();
      mctx.fillStyle = "#ffffff";
      mctx.fillRect(
        Math.min(start.x, pos.x),
        Math.min(start.y, pos.y),
        Math.abs(pos.x - start.x),
        Math.abs(pos.y - start.y),
      );
      mctx.restore();
      rectStartRef.current = null;
      commitMask();
    } else if (tool === "brush" || tool === "eraser") {
      lastPosRef.current = null;
      commitMask(); // 轮廓模式在此统一渲染边缘
    }
  };

  // ===== 清除 =====
  const clearMask = () => {
    const mask = logicMaskRef.current;
    if (!mask) return;
    pushUndo();
    const ctx = mask.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, mask.width, mask.height);
    commitMask();
  };

  // ===== 场景预设 =====
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (p.invert && hasMask()) invertMask(); // 换背景：涂了主体 → 自动反选
    setPrompt(p.text);
  };

  // 加载提示词库中的自定义预设（kind=preset）
  useEffect(() => {
    listExperiences("preset")
      .then((list) => setCustomPresets(list))
      .catch(() => { /* 后端不可用时仅保留内置预设 */ });
  }, []);

  // 点击自定义预设：读取全文填入编辑框
  const applyCustomPreset = async (meta: ExperienceMeta) => {
    try {
      const full = await getExperience(meta.id);
      if (full?.content) setPrompt(full.content.trim());
    } catch {
      setPrompt(meta.description || meta.name);
    }
  };

  // 把当前描述保存为自定义预设
  const savePreset = async () => {
    const name = presetName.trim();
    const content = prompt.trim();
    if (!name || !content) {
      setPresetError("请填写名称，并在描述框里写上要复用的指令");
      return;
    }
    setPresetSaving(true);
    setPresetError("");
    try {
      const item = await addExperience(name, content.slice(0, 80), content, "preset");
      setCustomPresets((prev) => [item, ...prev]);
      setPresetFormOpen(false);
      setPresetName("");
    } catch (e) {
      setPresetError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setPresetSaving(false);
    }
  };

  // ===== 导出 mask（黑底白色 PNG，支持羽化） =====
  const exportMask = (): string => {
    const mask = logicMaskRef.current;
    if (!mask) return "";

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return "";

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 羽化：缩放到世界尺寸时同步做高斯模糊（0 = 硬边二值）
    ctx.filter = feather > 0 ? `blur(${feather}px)` : "none";
    ctx.drawImage(mask, 0, 0, width, height);
    ctx.filter = "none";

    return exportCanvas.toDataURL("image/png");
  };

  // ===== mask 是否为空 =====
  const hasMask = (): boolean => {
    void maskVersion; // 依赖版本号触发重算
    const mask = logicMaskRef.current;
    if (!mask) return false;
    const ctx = mask.getContext("2d");
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  };

  const handleConfirm = () => {
    if (!hasMask()) return;
    const mask = exportMask();
    if (mask) {
      const size = calcSize(aspect, resolution);
      // 留空提示词时使用默认描述，与无蒙版修改保持一致
      onConfirm(mask, prompt.trim() || "按蒙版区域重新生成，保持周围内容一致", size, styleIds.length ? styleIds : undefined);
    }
  };

  // 是否可执行（快捷键 effect 依赖此值，需提前声明）
  const canExecute = hasMask();

  // ===== 快捷键录制（点击提示浮层里的按键后捕获下一次按键） =====
  useEffect(() => {
    if (!recordingAction) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 只按了修饰键：等待实际按键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // Esc 取消录制
      if (e.key === "Escape") {
        setRecordingAction(null);
        return;
      }

      // Backspace / Delete 解绑
      if (e.key === "Backspace" || e.key === "Delete") {
        onUpdateShortcut(recordingAction, "");
        setRecordingAction(null);
        return;
      }

      onUpdateShortcut(recordingAction, e.key, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: false,
      });
      setRecordingAction(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingAction, onUpdateShortcut]);

  // ===== 快捷键 =====
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (recordingAction) return; // 录制中由专门监听器处理

      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "TEXTAREA" || tag === "INPUT";

      // Esc：先关风格下拉 / 再关快捷键提示 / 最后退出编辑器
      if (e.key === "Escape") {
        if (styleOpen) {
          e.stopPropagation();
          setStyleOpen(false);
        } else if (showHelp) {
          e.stopPropagation();
          setShowHelp(false);
        } else {
          onCancel();
        }
        return;
      }

      // 确认编辑（输入框内同样生效）
      if (matchesShortcut(e, shortcutBindings.confirm) && canExecute) {
        e.preventDefault();
        handleConfirm();
        return;
      }

      if (inInput) return;

      // 快捷键提示浮层（全屏编辑器内随时可唤起）
      if (matchesShortcut(e, shortcutBindings.help)) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (showHelp) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        spaceRef.current = true;
        return;
      }

      if (matchesShortcut(e, shortcutBindings.brushSmaller)) {
        setBrushSize((s) => Math.max(5, s - 5));
        return;
      }
      if (matchesShortcut(e, shortcutBindings.brushLarger)) {
        setBrushSize((s) => Math.min(100, s + 5));
        return;
      }
      if (matchesShortcut(e, shortcutBindings.brush)) {
        setTool("brush");
        return;
      }
      if (matchesShortcut(e, shortcutBindings.eraser)) {
        setTool("eraser");
        return;
      }
      if (matchesShortcut(e, shortcutBindings.lasso)) {
        setTool("lasso");
        return;
      }
      if (matchesShortcut(e, shortcutBindings.rect)) {
        setTool("rect");
        return;
      }
      if (matchesShortcut(e, shortcutBindings.wand)) {
        if (pixelsReadable) setTool("wand");
        return;
      }
      if (matchesShortcut(e, shortcutBindings.invert)) {
        invertMask();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") spaceRef.current = false;
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleOpen, showHelp, recordingAction, shortcutBindings, undo, redo, onCancel, pixelsReadable, canExecute]);

  // ===== 风格下拉（原有逻辑保留） =====
  useEffect(() => {
    if (!styleOpen) return;
    const onDocDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (styleBtnRef.current?.contains(t) || styleListRef.current?.contains(t)) return;
      setStyleOpen(false);
    };
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  }, [styleOpen]);

  const [styleListPos, setStyleListPos] = useState({ left: 0, top: 0, width: 0 });
  useEffect(() => {
    if (!styleOpen || !styleBtnRef.current) return;
    const r = styleBtnRef.current.getBoundingClientRect();
    setStyleListPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [styleOpen]);

  const styleNames = experiences.filter((e) => styleIds.includes(e.id)).map((e) => e.name);
  const styleLabel =
    styleNames.length === 0
      ? "无（自由发挥）"
      : styleNames.length === 1
        ? styleNames[0]
        : `已选 ${styleNames.length} 个`;

  const toggleStyle = (id: string) => {
    setStyleIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  };

  const btnBase: React.CSSProperties = {
    padding: "5px 10px",
    fontSize: 12,
    border: "none",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  const toolBtn = (t: Tool): React.CSSProperties => ({
    ...btnBase,
    background: tool === t ? "rgba(167, 139, 250, 0.8)" : "rgba(255, 255, 255, 0.1)",
  });

  const cursorFor = () => {
    if (panningRef.current) return "grabbing";
    if (spaceRef.current) return "grab";
    if (tool === "eraser") return "cell";
    if (tool === "wand") return "pointer";
    return "crosshair";
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.92)",
        display: "flex",
        flexDirection: "column",
        zIndex: 9999,
      }}
    >
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 20px",
          background: "rgba(30, 30, 40, 0.95)",
          borderRadius: 8,
          margin: "12px 20px 0",
          alignItems: "center",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "#aaa", fontSize: 13, fontWeight: 600 }}>局部编辑</span>

        {/* 工具组 */}
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setTool("brush")} style={toolBtn("brush")} title="画笔 (B)，[ ] 调大小">画笔</button>
          <button onClick={() => setTool("eraser")} style={toolBtn("eraser")} title="橡皮擦 (E)">橡皮</button>
          <button onClick={() => setTool("lasso")} style={toolBtn("lasso")} title="套索 (L)：自由圈选">套索</button>
          <button onClick={() => setTool("rect")} style={toolBtn("rect")} title="矩形 (R)：框选区域">矩形</button>
          <button
            onClick={() => pixelsReadable && setTool("wand")}
            disabled={!pixelsReadable}
            style={{
              ...toolBtn("wand"),
              opacity: pixelsReadable ? 1 : 0.4,
              cursor: pixelsReadable ? "pointer" : "not-allowed",
            }}
            title={
              pixelsReadable
                ? "魔棒 (W)：点击选中相似颜色区域"
                : "当前图片不允许读取像素（跨域限制），魔棒不可用，请改用套索或画笔"
            }
          >
            魔棒
          </button>
        </div>

        {/* 笔刷大小 / 魔棒阈值（按工具切换） */}
        {(tool === "brush" || tool === "eraser") && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#888", fontSize: 12 }}>大小:</span>
            <input
              type="range" min="5" max="100" value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              style={{ width: 70 }}
            />
            <span style={{ color: "#aaa", fontSize: 12, width: 22 }}>{brushSize}</span>
          </div>
        )}
        {tool === "wand" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#888", fontSize: 12 }}>容差:</span>
            <input
              type="range" min="8" max="96" value={wandTol}
              onChange={(e) => setWandTol(Number(e.target.value))}
              style={{ width: 70 }}
            />
            <span style={{ color: "#aaa", fontSize: 12, width: 22 }}>{wandTol}</span>
          </div>
        )}

        {/* 选区操作 */}
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={invertMask} style={{ ...btnBase, background: "rgba(255,255,255,0.1)" }} title="反转选区 (I)：涂主体 → 反选 → 改背景">反选</button>
          <button onClick={undo} disabled={undoLen === 0} style={{ ...btnBase, background: "rgba(255,255,255,0.1)", opacity: undoLen ? 1 : 0.4 }} title="撤销 (Ctrl+Z)">撤销</button>
          <button onClick={redo} disabled={redoLen === 0} style={{ ...btnBase, background: "rgba(255,255,255,0.1)", opacity: redoLen ? 1 : 0.4 }} title="重做 (Ctrl+Shift+Z)">重做</button>
          <button
            onClick={clearMask}
            style={{ ...btnBase, background: "rgba(239, 68, 68, 0.3)", border: "1px solid rgba(239, 68, 68, 0.5)", color: "#f87171" }}
          >
            清除
          </button>
        </div>

        {/* 显示模式 */}
        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid rgba(255,255,255,0.15)" }}>
          <button
            onClick={() => setViewMode("overlay")}
            style={{ ...btnBase, borderRadius: 0, background: viewMode === "overlay" ? "rgba(167,139,250,0.8)" : "rgba(255,255,255,0.08)" }}
            title="叠加模式：紫色半透明覆盖"
          >
            叠加
          </button>
          <button
            onClick={() => setViewMode("outline")}
            style={{ ...btnBase, borderRadius: 0, background: viewMode === "outline" ? "rgba(167,139,250,0.8)" : "rgba(255,255,255,0.08)" }}
            title="轮廓模式：只描边，不遮挡原图细节"
          >
            轮廓
          </button>
        </div>

        <button
          onMouseDown={() => setViewOriginal(true)}
          onMouseUp={() => setViewOriginal(false)}
          onMouseLeave={() => setViewOriginal(false)}
          onTouchStart={() => setViewOriginal(true)}
          onTouchEnd={() => setViewOriginal(false)}
          style={{ ...btnBase, background: viewOriginal ? "rgba(99, 102, 241, 0.6)" : "rgba(255, 255, 255, 0.1)" }}
        >
          {viewOriginal ? "正在查看原图" : "按住查看原图"}
        </button>

        <button onClick={resetView} style={{ ...btnBase, background: "rgba(255,255,255,0.1)" }} title="重置缩放与平移（滚轮缩放，空格+拖拽平移）">
          适应窗口
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowHelp((v) => !v)}
            style={{ ...btnBase, background: showHelp ? "rgba(167, 139, 250, 0.5)" : "rgba(255, 255, 255, 0.1)" }}
            title={`快捷键提示（${formatShortcut(shortcutBindings.help)}）`}
          >
            ?
          </button>
          <button onClick={onCancel} style={{ ...btnBase, background: "rgba(255, 255, 255, 0.1)" }}>
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canExecute}
            style={{
              ...btnBase,
              background: canExecute ? "rgba(167, 139, 250, 0.8)" : "rgba(167, 139, 250, 0.3)",
              cursor: canExecute ? "pointer" : "not-allowed",
            }}
          >
            确认编辑
          </button>
        </div>
      </div>

      {/* 主体区域：左画布 + 右控制面板 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          gap: 16,
          padding: "12px 20px",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {/* 画布区域：滚轮缩放 / 空格+拖拽平移 */}
        <div
          ref={stageRef}
          style={{
            position: "relative",
            flex: 1,
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {isLoading && (
            <div style={{ color: "#888", fontSize: 14, position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              加载图片中...
            </div>
          )}
          {!isLoading && (
            <div
              ref={wrapperRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transformOrigin: "0 0",
              }}
            >
              {/* 原图层 */}
              <canvas
                ref={baseCanvasRef}
                style={{
                  display: "block",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 4,
                }}
              />
              {/* 可视/交互层 */}
              <canvas
                ref={displayCanvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  cursor: cursorFor(),
                  visibility: viewOriginal ? "hidden" : "visible",
                }}
              />
            </div>
          )}
          {wandFailed && (
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(239, 68, 68, 0.2)",
                border: "1px solid rgba(239, 68, 68, 0.5)",
                color: "#f87171",
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 6,
              }}
            >
              这张图片不允许读取像素，魔棒暂时用不了，已切回画笔。可以改用套索或矩形框选区域。
              <button
                onClick={() => setWandFailed(false)}
                style={{ marginLeft: 8, background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 12 }}
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* 右侧控制面板 */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 16,
            background: "rgba(30, 30, 40, 0.95)",
            borderRadius: 8,
            overflowY: "auto",
          }}
        >
          {/* 场景预设：内置 + 提示词库自定义 */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.62)" }}>场景预设（一键填入指令）</span>
              {customPresets.length > 0 && (
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>来自提示词库</span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p)}
                  style={{
                    padding: "6px 8px",
                    fontSize: 12,
                    border: "1px solid rgba(167,139,250,0.35)",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: "rgba(167,139,250,0.12)",
                    color: "#c4b5fd",
                  }}
                  title={p.invert ? "会自动反转当前选区（先涂出要保留的主体）" : undefined}
                >
                  {p.key}
                </button>
              ))}
              {customPresets.map((meta) => (
                <button
                  key={meta.id}
                  onClick={() => applyCustomPreset(meta)}
                  style={customPresetStyle}
                  title={meta.description || meta.name}
                >
                  {meta.name}
                </button>
              ))}
            </div>

            {/* 自定义预设：把当前描述存进提示词库（kind=preset） */}
            {!presetFormOpen ? (
              <button
                onClick={() => {
                  setPresetName("");
                  setPresetError("");
                  setPresetFormOpen(true);
                }}
                style={{ ...customPresetStyle, width: "100%", marginTop: 6, borderStyle: "dashed" }}
              >
                ＋ 把当前描述存为预设
              </button>
            ) : (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="预设名称，如：卡通头像"
                  autoFocus
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    fontSize: 12,
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 6,
                    color: "#fff",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={savePreset}
                    disabled={presetSaving}
                    style={{
                      flex: 1,
                      padding: "5px 8px",
                      fontSize: 12,
                      border: "none",
                      borderRadius: 6,
                      cursor: presetSaving ? "not-allowed" : "pointer",
                      background: "rgba(167,139,250,0.8)",
                      color: "#fff",
                      opacity: presetSaving ? 0.6 : 1,
                    }}
                  >
                    {presetSaving ? "保存中…" : "保存"}
                  </button>
                  <button
                    onClick={() => setPresetFormOpen(false)}
                    style={{
                      flex: 1,
                      padding: "5px 8px",
                      fontSize: 12,
                      border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: "transparent",
                      color: "rgba(255,255,255,0.7)",
                    }}
                  >
                    取消
                  </button>
                </div>
                {presetError && (
                  <div style={{ fontSize: 11, color: "#f87171" }}>{presetError}</div>
                )}
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
                  会把上方描述框里的内容存进提示词库，之后可一键复用
                </div>
              </div>
            )}
          </div>

          {/* 描述输入 */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
              编辑描述（可留空，默认按蒙版重绘）
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="如：把衣服改成红色、背景换成夕阳、去掉眼镜"
              style={{
                width: "100%",
                height: 281,
                minHeight: 120,
                padding: "8px 10px",
                fontSize: 13,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#fff",
                resize: "vertical",
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
              onKeyDown={() => {
                // 确认快捷键统一由文档级监听处理（见快捷键 effect），避免重复触发
              }}
            />
            <div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>
              {formatShortcut(shortcutBindings.confirm)} 确认 · {formatShortcut(shortcutBindings.help)} 快捷键提示
            </div>
          </div>

          {/* 羽化 */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}>
              <span>边缘羽化：{feather === 0 ? "关闭（硬边）" : `${feather}px`}</span>
              <button
                onClick={() => setShowFeatherHelp((v) => !v)}
                title="羽化说明"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  border: "1px solid rgba(167,139,250,0.6)",
                  background: showFeatherHelp ? "rgba(167,139,250,0.35)" : "transparent",
                  color: "#a78bfa",
                  fontSize: 10,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                ?
              </button>
            </div>
            <input
              type="range" min="0" max="20" value={feather}
              onChange={(e) => setFeather(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            {showFeatherHelp && (
              <div
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  background: "rgba(167,139,250,0.08)",
                  border: "1px solid rgba(167,139,250,0.25)",
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: 1.75,
                  color: "rgba(255,255,255,0.72)",
                }}
              >
                <div>羽化 = 蒙版边缘的渐变过渡宽度（单位：原图像素），不是给图片加模糊。</div>
                <div style={{ marginTop: 4 }}>
                  注意：多数生图接口会把蒙版二值化，灰阶过渡可能被丢弃，实际表现更接近「边界外扩 / 内缩」。
                </div>
                <div style={{ marginTop: 4, color: "#a78bfa" }}>
                  建议：换色 / 换物体用 0–5；云、烟、光晕、头发用 10–20。
                </div>
              </div>
            )}
          </div>

          {/* 宽高比 */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
              宽高比
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setAspect(r.key)}
                  style={{
                    padding: "4px 8px",
                    fontSize: 11,
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    background: aspect === r.key ? "rgba(167, 139, 250, 0.8)" : "rgba(255,255,255,0.08)",
                    color: aspect === r.key ? "#fff" : "#aaa",
                  }}
                >
                  {r.key}
                </button>
              ))}
            </div>
          </div>

          {/* 分辨率 */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
              分辨率
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {RESOLUTIONS.map((res) => (
                <button
                  key={res}
                  onClick={() => setResolution(res)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 11,
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    background: resolution === res ? "rgba(167, 139, 250, 0.8)" : "rgba(255,255,255,0.08)",
                    color: resolution === res ? "#fff" : "#aaa",
                  }}
                >
                  {res}
                </button>
              ))}
            </div>
          </div>

          {/* 技能库（与画布生成面板共用同一份 kind=style 数据） */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
              技能库（可多选）
            </div>
            {experiences.length > 0 ? (
              <button
                ref={styleBtnRef}
                onClick={() => setStyleOpen((o) => !o)}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: 12,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 6,
                  color: "#ddd",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {styleLabel}
              </button>
            ) : (
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: 11,
                  lineHeight: 1.7,
                  color: "rgba(255,255,255,0.45)",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px dashed rgba(255,255,255,0.15)",
                  borderRadius: 6,
                }}
              >
                技能库为空。在「设置 → 技能库」导入风格后，这里会自动出现，可多选
              </div>
            )}
          </div>

          {/* 提示 */}
          <div style={{ fontSize: 11, color: "#555", marginTop: "auto", lineHeight: 1.7 }}>
            <div>画笔/套索/矩形/魔棒标记修改区域</div>
            <div>魔棒点纯色区域（天空/背景）一键选中</div>
            <div>「反选」：涂主体 → 反转 → 换背景</div>
            <div>滚轮缩放，空格+拖拽平移</div>
            <div
              onClick={() => setShowHelp(true)}
              style={{ color: "#8b7cf6", cursor: "pointer" }}
            >
              {formatShortcut(shortcutBindings.help)} 查看 / 修改快捷键
            </div>
          </div>
        </div>
      </div>

      {/* 快捷键提示浮层（? 唤起，可直接改键） */}
      {showHelp && createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10002,
            background: "rgba(0, 0, 0, 0.66)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setShowHelp(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 560,
              maxWidth: "92vw",
              maxHeight: "82vh",
              overflowY: "auto",
              background: "rgba(28, 28, 38, 0.98)",
              border: "1px solid rgba(167, 139, 250, 0.35)",
              borderRadius: 12,
              padding: "20px 24px",
              color: "#e5e7eb",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.6)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>快捷键</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => onResetShortcuts("editor")}
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 6,
                    color: "#9ca3af",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "4px 10px",
                  }}
                >
                  恢复默认
                </button>
                <button
                  onClick={() => setShowHelp(false)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9ca3af",
                    cursor: "pointer",
                    fontSize: 20,
                    lineHeight: 1,
                    padding: "2px 6px",
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {recordingAction && (
              <div
                style={{
                  background: "rgba(167,139,250,0.15)",
                  border: "1px solid rgba(167,139,250,0.4)",
                  borderRadius: 8,
                  padding: "10px 14px",
                  marginBottom: 12,
                  fontSize: 12,
                  color: "#a78bfa",
                }}
              >
                正在录制「{shortcutBindings[recordingAction].description}」· 按下新按键，Backspace 解绑，Esc 取消
              </div>
            )}

            {conflicts.length > 0 && (
              <div
                style={{
                  background: "rgba(239,68,68,0.15)",
                  border: "1px solid rgba(239,68,68,0.4)",
                  borderRadius: 8,
                  padding: "8px 14px",
                  marginBottom: 12,
                  fontSize: 12,
                  color: "#fca5a5",
                }}
              >
                {conflicts.map((c, i) => (
                  <div key={i}>
                    「{c.actions.map((a) => EDITOR_ACTIONS.find((x) => x.action === a)?.label ?? a).join("」和「")}」都绑定了 {c.binding}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 22px" }}>
              {EDITOR_ACTIONS.map(({ action, label }) => {
                const binding = shortcutBindings[action];
                const recording = recordingAction === action;
                const conflict = conflicts.some((c) => c.actions.includes(action));
                return (
                  <div
                    key={action}
                    onClick={() => {
                      if (!binding.editable || recordingAction) return;
                      setRecordingAction(action);
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 8px",
                      borderRadius: 4,
                      background: recording ? "rgba(167,139,250,0.15)" : "transparent",
                      cursor: recordingAction ? "default" : "pointer",
                    }}
                    title="点击后按下新按键；Backspace 解绑"
                  >
                    <span style={{ fontSize: 13, color: "#d1d5db" }}>{label}</span>
                    <kbd
                      style={{
                        background: conflict ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.08)",
                        border: conflict ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,255,255,0.15)",
                        borderRadius: 4,
                        padding: "2px 8px",
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: conflict ? "#f87171" : binding.key ? "#a78bfa" : "#6b7280",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {recording ? "按下按键..." : formatShortcut(binding)}
                    </kbd>
                  </div>
                );
              })}
            </div>

            <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, margin: "16px 0 6px" }}>
              鼠标操作（不可修改）
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 22px" }}>
              {[
                ["缩放画布", "滚轮"],
                ["平移画布", "空格 + 拖拽"],
                ["临时查看原图", "按住按钮"],
                ["撤销 / 重做", "Ctrl+Z / Ctrl+Shift+Z"],
              ].map(([label, keyName]) => (
                <div
                  key={label}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "6px 8px" }}
                >
                  <span style={{ fontSize: 13, color: "#d1d5db" }}>{label}</span>
                  <kbd
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: "#9ca3af",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {keyName}
                  </kbd>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
              点击紫色按键可修改 · Backspace 解绑 · 画布级快捷键请在画布左下角 ? 中设置
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 风格下拉（portal 到 body） */}
      {styleOpen && experiences.length > 0 && createPortal(
        <div
          ref={styleListRef}
          style={{
            position: "fixed",
            left: styleListPos.left,
            top: styleListPos.top,
            width: styleListPos.width,
            maxHeight: 200,
            overflowY: "auto",
            background: "rgba(20, 20, 30, 0.98)",
            border: "1px solid rgba(167, 139, 250, 0.4)",
            borderRadius: 6,
            padding: 4,
            zIndex: 10001,
            backdropFilter: "blur(8px)",
          }}
        >
          {experiences.map((exp) => (
            <div
              key={exp.id}
              onClick={() => toggleStyle(exp.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                cursor: "pointer",
                borderRadius: 4,
                background: styleIds.includes(exp.id) ? "rgba(167, 139, 250, 0.2)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!styleIds.includes(exp.id)) e.currentTarget.style.background = "rgba(255,255,255,0.06)";
              }}
              onMouseLeave={(e) => {
                if (!styleIds.includes(exp.id)) e.currentTarget.style.background = "transparent";
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: "1px solid rgba(255,255,255,0.3)",
                  background: styleIds.includes(exp.id) ? "rgba(167, 139, 250, 0.9)" : "transparent",
                  flexShrink: 0,
                }}
              />
              <div>
                <div style={{ fontSize: 12, color: "#ddd" }}>{exp.name}</div>
                {exp.description && (
                  <div style={{ fontSize: 10, color: "#666" }}>{exp.description}</div>
                )}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
