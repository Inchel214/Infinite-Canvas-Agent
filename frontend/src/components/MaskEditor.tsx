/**
 * 蒙版编辑器组件：用于局部编辑（Inpainting）
 * 用户可以在原图上画蒙版（紫色半透明区域），同时输入修改描述
 * mask 导出为黑底白色 PNG（API 要求白=要修改的区域）
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ExperienceMeta } from "../api/agent";
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
  onConfirm: (mask: string, prompt: string, size: string, experienceIds?: string[]) => void;
  onCancel: () => void;
}

type Tool = "brush" | "eraser";

export function MaskEditor({ imageUrl, width, height, experiences, onConfirm, onCancel }: MaskEditorProps) {
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(30);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState(() => closestAspectKey(width, height));
  const [resolution, setResolution] = useState("2K");
  const [styleIds, setStyleIds] = useState<string[]>([]);
  const [styleOpen, setStyleOpen] = useState(false);
  const [viewOriginal, setViewOriginal] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const styleBtnRef = useRef<HTMLButtonElement>(null);
  const styleListRef = useRef<HTMLDivElement>(null);

  // 加载图片后读取原始像素尺寸，用于推断分辨率
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
      setResolution(closestResolutionKey(longEdge));
      setIsLoading(false);
    };
    img.onerror = () => {
      console.error("Failed to load image");
      setIsLoading(false);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // 计算缩放比例，使图片适应容器
  const getScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 1;
    const maxW = container.clientWidth - 20;
    const maxH = container.clientHeight - 20;
    const scale = Math.min(maxW / width, maxH / height, 1);
    return scale;
  }, [width, height]);

  // 初始化/重绘画布（图片加载完成或缩放变化时）
  useEffect(() => {
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!canvas || !maskCanvas || !imageRef.current || isLoading) return;

    const scale = getScale();
    const displayW = Math.round(width * scale);
    const displayH = Math.round(height * scale);

    canvas.width = displayW;
    canvas.height = displayH;
    maskCanvas.width = displayW;
    maskCanvas.height = displayH;

    // 重绘原图
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, displayW, displayH);
      ctx.drawImage(imageRef.current, 0, 0, displayW, displayH);
    }
  }, [isLoading, width, height, getScale]);

  // 获取鼠标在画布上的位置
  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  // 开始绘画
  const startDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    draw(e);
  };

  // 绘画中
  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing && e.type !== "mousedown") return;
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;

    const pos = getPos(e);

    // 画笔：紫色半透明（不遮挡原图细节）；橡皮擦：擦除 mask
    ctx.globalCompositeOperation = tool === "brush" ? "source-over" : "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = tool === "brush" ? "rgba(167, 139, 250, 0.45)" : "rgba(0, 0, 0, 1)";
    ctx.fill();
  };

  // 结束绘画
  const endDraw = () => {
    setIsDrawing(false);
  };

  // 清除蒙版
  const clearMask = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  };

  // 导出蒙版为 base64 PNG（与原图同样大小，黑底白色区域）
  const exportMask = (): string => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return "";

    // 创建与原图同样大小的画布
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return "";

    // 填充黑色背景
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 缩放蒙版到原图大小
    const scaleX = width / maskCanvas.width;
    const scaleY = height / maskCanvas.height;
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(maskCanvas, 0, 0);

    return exportCanvas.toDataURL("image/png");
  };

  // 检查 mask 是否为空（所有像素都是黑色/透明）
  const hasMask = (): boolean => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return false;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true; // 有非透明像素
    }
    return false;
  };

  // 确认
  const handleConfirm = () => {
    if (!prompt.trim()) return;
    if (!hasMask()) return;
    const mask = exportMask();
    if (mask) {
      const size = calcSize(aspect, resolution);
      onConfirm(mask, prompt.trim(), size, styleIds.length ? styleIds : undefined);
    }
  };

  // 风格下拉点击外部关闭
  useEffect(() => {
    if (!styleOpen) return;
    const onDocDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (styleBtnRef.current?.contains(t) || styleListRef.current?.contains(t)) return;
      setStyleOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setStyleOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [styleOpen]);

  // 风格下拉定位
  const [styleListPos, setStyleListPos] = useState({ left: 0, top: 0, width: 0 });
  useEffect(() => {
    if (!styleOpen || !styleBtnRef.current) return;
    const r = styleBtnRef.current.getBoundingClientRect();
    setStyleListPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [styleOpen]);

  const canExecute = prompt.trim().length > 0 && hasMask();

  // 风格名称
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

  // 通用按钮样式
  const btnBase: React.CSSProperties = {
    padding: "6px 12px",
    fontSize: 12,
    border: "none",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
  };

  return (
    <div
      ref={containerRef}
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
          gap: 12,
          padding: "10px 20px",
          background: "rgba(30, 30, 40, 0.95)",
          borderRadius: 8,
          margin: "12px 20px 0",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#aaa", fontSize: 13, fontWeight: 600 }}>局部编辑</span>
        <span style={{ color: "#666", fontSize: 12 }}>用紫色标记要修改的区域</span>

        <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
          <button
            onClick={() => setTool("brush")}
            style={{
              ...btnBase,
              background: tool === "brush" ? "rgba(167, 139, 250, 0.8)" : "rgba(255, 255, 255, 0.1)",
            }}
          >
            画笔
          </button>
          <button
            onClick={() => setTool("eraser")}
            style={{
              ...btnBase,
              background: tool === "eraser" ? "rgba(167, 139, 250, 0.8)" : "rgba(255, 255, 255, 0.1)",
            }}
          >
            橡皮擦
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#888", fontSize: 12 }}>大小:</span>
          <input
            type="range"
            min="5"
            max="100"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span style={{ color: "#aaa", fontSize: 12, width: 24 }}>{brushSize}</span>
        </div>

        <button
          onClick={clearMask}
          style={{
            ...btnBase,
            background: "rgba(239, 68, 68, 0.3)",
            border: "1px solid rgba(239, 68, 68, 0.5)",
            color: "#f87171",
          }}
        >
          清除
        </button>

        {/* 按住查看原图 */}
        <button
          onMouseDown={() => setViewOriginal(true)}
          onMouseUp={() => setViewOriginal(false)}
          onMouseLeave={() => setViewOriginal(false)}
          onTouchStart={() => setViewOriginal(true)}
          onTouchEnd={() => setViewOriginal(false)}
          style={{
            ...btnBase,
            background: viewOriginal ? "rgba(99, 102, 241, 0.6)" : "rgba(255, 255, 255, 0.1)",
          }}
        >
          {viewOriginal ? "正在查看原图" : "按住查看原图"}
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ ...btnBase, background: "rgba(255, 255, 255, 0.1)" }}
          >
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
        {/* 画布区域 */}
        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {isLoading && (
            <div style={{ color: "#888", fontSize: 14 }}>加载图片中...</div>
          )}
          {!isLoading && (
            <div
              style={{
                position: "relative",
                maxWidth: "100%",
                maxHeight: "100%",
              }}
            >
              {/* 原图层 */}
              <canvas
                ref={canvasRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 4,
                }}
              />
              {/* 蒙版层（可绘画，viewOriginal 时隐藏） */}
              <canvas
                ref={maskCanvasRef}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                style={{
                  position: "relative",
                  cursor: tool === "brush" ? "crosshair" : "cell",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 4,
                  visibility: viewOriginal ? "hidden" : "visible",
                }}
              />
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
          {/* 描述输入 */}
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
              编辑描述（必填）
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="如：把衣服改成红色、背景换成夕阳、去掉眼镜"
              style={{
                width: "100%",
                minHeight: 72,
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canExecute) {
                  handleConfirm();
                }
              }}
            />
            <div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>
              Ctrl+Enter 确认
            </div>
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

          {/* 风格选择 */}
          {experiences.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", marginBottom: 5 }}>
                风格（可多选）
              </div>
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
            </div>
          )}

          {/* 提示 */}
          <div style={{ fontSize: 11, color: "#555", marginTop: "auto", lineHeight: 1.6 }}>
            <div>1. 用画笔在图片上标记要修改的区域</div>
            <div>2. 输入描述告诉 AI 怎么改那个区域</div>
            <div>3. mask 区域和描述要匹配</div>
          </div>
        </div>
      </div>

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
