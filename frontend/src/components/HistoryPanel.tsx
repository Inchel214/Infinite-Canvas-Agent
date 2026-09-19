import { useState } from "react";

export interface HistoryItem {
  id: string;
  prompt: string;
  message: string;
  tool?: string;
  timestamp: number;
  success: boolean;
}

interface HistoryPanelProps {
  items: HistoryItem[];
}

const TOOL_LABELS: Record<string, string> = {
  generate_image: "文生图",
  variate_image: "图生图",
  edit_image: "局部编辑",
  compose_images: "多图组合",
  move_node: "移动节点",
  delete_node: "删除节点",
  list_nodes: "查看节点",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function HistoryPanel({ items }: HistoryPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        width: 320,
        maxHeight: collapsed ? 48 : "60vh",
        background: "rgba(26,26,46,0.95)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
        zIndex: 1000,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* 标题栏 */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          cursor: "pointer",
          borderBottom: collapsed ? "none" : "1px solid rgba(255,255,255,0.08)",
          color: "#aaa",
          fontSize: 12,
          userSelect: "none",
        }}
      >
        <span>指令历史 ({items.length})</span>
        <span>{collapsed ? "展开" : "收起"}</span>
      </div>

      {/* 历史列表 */}
      {!collapsed && (
        <div
          style={{
            overflowY: "auto",
            flex: 1,
            padding: "4px 0",
          }}
        >
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                padding: "8px 14px",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                fontSize: 13,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ color: "#666", fontSize: 11 }}>{formatTime(item.timestamp)}</span>
                {item.tool && (
                  <span
                    style={{
                      background: "rgba(99,102,241,0.2)",
                      color: "#a5b4fc",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: 10,
                    }}
                  >
                    {TOOL_LABELS[item.tool] || item.tool}
                  </span>
                )}
                <span style={{ color: item.success ? "#4ade80" : "#f87171", fontSize: 11 }}>
                  {item.success ? "成功" : "失败"}
                </span>
              </div>
              <div style={{ color: "#ddd", marginBottom: 2 }}>{item.prompt}</div>
              {item.message && item.message !== "操作已完成。" && (
                <div style={{ color: "#888", fontSize: 12 }}>{item.message}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
