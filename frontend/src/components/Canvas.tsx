import { useEffect, useRef, useCallback, useState } from "react";
import type { CanvasState, CanvasNode } from "../types/canvas";

interface CanvasProps {
  canvasState: CanvasState | null;
  canvasId: string | null;
  onNodeMoved?: (nodeId: string, x: number, y: number) => void;
}

/**
 * 轻量无限画布：零依赖，CSS transform 实现 pan/zoom
 * 支持：滚轮缩放、拖拽平移、图片拖拽移动、自动适配
 */
export function Canvas({ canvasState, canvasId, onNodeMoved }: CanvasProps) {
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

  const rawNodes = canvasState ? Object.values(canvasState.nodes) : [];

  // 合并本地覆盖位置
  const nodes = rawNodes.map((n) => {
    const ov = localOverrides[n.id];
    return ov ? { ...n, x: ov.x, y: ov.y } : n;
  });

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

  // 背景拖拽平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 只在点击背景时启动 pan
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.role === "world") {
      setIsPanning(true);
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
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
  }, [draggingNode, isPanning, pan, zoom, dragOffset]);

  const handleMouseUp = useCallback(() => {
    if (draggingNode) {
      // 拖拽结束，通知后端
      const pos = localOverrides[draggingNode];
      if (pos && onNodeMoved) {
        onNodeMoved(draggingNode, pos.x, pos.y);
      }
      setDraggingNode(null);
    }
    setIsPanning(false);
  }, [draggingNode, localOverrides, onNodeMoved]);

  // 图片节点拖拽开始
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

    setDragOffset({
      x: worldX - node.x,
      y: worldY - node.y,
    });
    setDraggingNode(node.id);
  }, [pan, zoom]);

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#1a1a2e",
        cursor: isPanning ? "grabbing" : draggingNode ? "move" : "grab",
      }}
    >
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
        {/* 连线层 */}
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
                const x1 = src.x + src.width;
                const y1 = src.y + src.height / 2;
                const x2 = target.x;
                const y2 = target.y + target.height / 2;
                const dx = Math.max(40, (x2 - x1) / 2);
                const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                return (
                  <g key={`${sid}-${target.id}`}>
                    <path
                      d={path}
                      fill="none"
                      stroke="rgba(99,102,241,0.6)"
                      strokeWidth={3}
                      strokeLinecap="round"
                    />
                    <circle cx={x1} cy={y1} r={5} fill="#6366f1" />
                    <circle cx={x2} cy={y2} r={5} fill="#6366f1" />
                  </g>
                );
              })
            )}
        </svg>

        {nodes.map((node) => (
          <ImageNode
            key={node.id}
            node={node}
            isDragging={draggingNode === node.id}
            isHovered={hoveredNode === node.id}
            isLinked={!!(node.source_ids && node.source_ids.length > 0)}
            onMouseDown={(e) => handleNodeMouseDown(e, node)}
            onMouseEnter={() => setHoveredNode(node.id)}
            onMouseLeave={() => setHoveredNode(null)}
          />
        ))}
      </div>

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
 * 图片节点：渲染单个图片，可拖拽
 */
function ImageNode({
  node,
  isDragging,
  isHovered,
  isLinked,
  onMouseDown,
  onMouseEnter,
  onMouseLeave,
}: {
  node: CanvasNode;
  isDragging: boolean;
  isHovered: boolean;
  isLinked: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  if (node.type === "image" && node.image_url) {
    return (
      <>
        <img
          src={node.image_url}
          alt={node.content || "image"}
          draggable={false}
          onMouseDown={onMouseDown}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          style={{
            position: "absolute",
            left: node.x,
            top: node.y,
            width: node.width,
            height: node.height,
            objectFit: "cover",
            borderRadius: 8,
            boxShadow: isDragging
              ? "0 8px 40px rgba(99,102,241,0.5)"
              : isHovered
                ? "0 4px 24px rgba(255,255,255,0.2)"
                : "0 4px 20px rgba(0,0,0,0.4)",
            cursor: isDragging ? "move" : "pointer",
            outline: isDragging
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
        {isLinked && (
          <div
            style={{
              position: "absolute",
              left: node.x,
              top: node.y - 24,
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
      </>
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
