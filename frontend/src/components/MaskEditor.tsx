/**
 * 蒙版编辑器组件：用于局部编辑（Inpainting）
 * 用户可以在图片上画蒙版（白色区域为要修改的部分）
 */
import { useState, useRef, useEffect, useCallback } from "react";

interface MaskEditorProps {
  imageUrl: string;
  width: number;
  height: number;
  onConfirm: (mask: string) => void;
  onCancel: () => void;
}

type Tool = "brush" | "eraser";

export function MaskEditor({ imageUrl, width, height, onConfirm, onCancel }: MaskEditorProps) {
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(30);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // 计算缩放比例，使图片适应容器
  const getScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 1;
    const maxW = container.clientWidth - 20;
    const maxH = container.clientHeight - 120; // 留出工具栏空间
    const scale = Math.min(maxW / width, maxH / height, 1);
    return scale;
  }, [width, height]);

  // 初始化画布
  useEffect(() => {
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!canvas || !maskCanvas) return;

    const scale = getScale();
    const displayW = Math.round(width * scale);
    const displayH = Math.round(height * scale);

    canvas.width = displayW;
    canvas.height = displayH;
    maskCanvas.width = displayW;
    maskCanvas.height = displayH;

    // 加载图片
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0, displayW, displayH);
      }
      setIsLoading(false);
    };
    img.onerror = () => {
      console.error("Failed to load image");
      setIsLoading(false);
    };
    img.src = imageUrl;
  }, [imageUrl, width, height, getScale]);

  // 获取鼠标在画布上的位置
  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
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

    ctx.globalCompositeOperation = tool === "brush" ? "source-over" : "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = tool === "brush" ? "rgba(255, 255, 255, 0.8)" : "rgba(0, 0, 0, 1)";
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

  // 导出蒙版为 base64 PNG（需要与原图同样大小）
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

  // 确认
  const handleConfirm = () => {
    const mask = exportMask();
    if (mask) {
      onConfirm(mask);
    }
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
        background: "rgba(0, 0, 0, 0.9)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "12px 20px",
          background: "rgba(30, 30, 40, 0.95)",
          borderRadius: 8,
          marginBottom: 16,
          alignItems: "center",
        }}
      >
        <span style={{ color: "#aaa", fontSize: 13 }}>局部编辑 - 用白色标记要修改的区域</span>

        <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
          <button
            onClick={() => setTool("brush")}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              background: tool === "brush" ? "rgba(99, 102, 241, 0.8)" : "rgba(255, 255, 255, 0.1)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
            }}
          >
            画笔
          </button>
          <button
            onClick={() => setTool("eraser")}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              background: tool === "eraser" ? "rgba(99, 102, 241, 0.8)" : "rgba(255, 255, 255, 0.1)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
            }}
          >
            橡皮擦
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
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
            padding: "6px 12px",
            fontSize: 12,
            background: "rgba(239, 68, 68, 0.3)",
            border: "1px solid rgba(239, 68, 68, 0.5)",
            borderRadius: 4,
            color: "#f87171",
            cursor: "pointer",
            marginLeft: 8,
          }}
        >
          清除
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: "rgba(255, 255, 255, 0.1)",
              border: "none",
              borderRadius: 4,
              color: "#aaa",
              cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: "rgba(99, 102, 241, 0.8)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
            }}
          >
            确认编辑
          </button>
        </div>
      </div>

      {/* 画布区域 */}
      <div
        style={{
          position: "relative",
          maxWidth: "90vw",
          maxHeight: "calc(90vh - 100px)",
        }}
      >
        {isLoading && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              color: "#888",
            }}
          >
            加载中...
          </div>
        )}
        {/* 原图层 */}
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            border: "1px solid rgba(255, 255, 255, 0.2)",
          }}
        />
        {/* 蒙版层（可绘画） */}
        <canvas
          ref={maskCanvasRef}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          style={{
            position: "relative",
            cursor: tool === "brush" ? "crosshair" : "cell",
            border: "1px solid rgba(255, 255, 255, 0.2)",
          }}
        />
      </div>

      {/* 提示 */}
      <div style={{ color: "#666", fontSize: 12, marginTop: 12 }}>
        提示：用画笔在图片上标记要修改的区域（白色），然后点击"确认编辑"
      </div>
    </div>
  );
}
