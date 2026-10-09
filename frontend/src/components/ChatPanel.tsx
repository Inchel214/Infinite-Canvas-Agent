import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chatWithAgent,
  getChatHistory,
  clearChatHistory,
} from "../api/agent";
import type { AgentStep, CanvasState } from "../types/canvas";

// 面板内展示条目：历史消息不含 steps（后端只存文本对），本轮对话带工具调用过程
interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  timestamp: number;
  error?: boolean;
}

interface ChatPanelProps {
  canvasId: string | null;
  // Agent 操作画布后（生成/移动/删除节点）通知上层刷新画布状态
  onCanvasUpdate: (canvas: CanvasState) => void;
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
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Markdown 渲染样式（Agent 回复用，暗色适配）：表格可横向滚动，代码块/行内代码深底
const mdComponents = {
  p: ({ children }: { children?: ReactNode }) => (
    <p style={{ margin: "0 0 6px" }}>{children}</p>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={{ margin: "8px 0 6px", fontSize: 15 }}>{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 style={{ margin: "8px 0 6px", fontSize: 15 }}>{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 style={{ margin: "8px 0 6px", fontSize: 14 }}>{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 style={{ margin: "8px 0 6px", fontSize: 13.5 }}>{children}</h4>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol style={{ margin: "4px 0", paddingLeft: 18 }}>{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li style={{ marginBottom: 2 }}>{children}</li>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div style={{ overflowX: "auto", margin: "4px 0" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th
      style={{
        border: "1px solid rgba(255,255,255,0.18)",
        padding: "4px 8px",
        textAlign: "left",
        background: "rgba(255,255,255,0.07)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td style={{ border: "1px solid rgba(255,255,255,0.14)", padding: "4px 8px" }}>
      {children}
    </td>
  ),
  // 行内代码深底；块内代码（带 language- class）由 pre 提供背景
  code: ({ children, className }: { children?: ReactNode; className?: string }) =>
    className ? (
      <code className={className} style={{ fontFamily: "Consolas, monospace", fontSize: 13 }}>
        {children}
      </code>
    ) : (
      <code
        style={{
          background: "rgba(0,0,0,0.35)",
          padding: "1px 5px",
          borderRadius: 4,
          fontFamily: "Consolas, monospace",
          fontSize: 13,
        }}
      >
        {children}
      </code>
    ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre
      style={{
        background: "rgba(0,0,0,0.35)",
        padding: 10,
        borderRadius: 8,
        overflowX: "auto",
        fontSize: 12.5,
        margin: "4px 0",
      }}
    >
      {children}
    </pre>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#a5b4fc" }}>
      {children}
    </a>
  ),
};

// 面板横向拉伸范围：最小=当前默认宽，最大不超过视口留白
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 720;

export function ChatPanel({ canvasId, onCanvasUpdate }: ChatPanelProps) {
  // 面板开合状态持久化：刷新后保持上次收起/打开状态
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("chatPanelOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleOpen = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem("chatPanelOpen", next ? "1" : "0");
    } catch {
      /* 忽略隐私模式等写入失败 */
    }
  };
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [hoverHandle, setHoverHandle] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 左边缘拖拽拉伸：往左拖变宽，往右拖变窄，clamp 到 [MIN, MAX]
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const s = resizeRef.current;
      if (!s) return;
      const max = Math.min(MAX_PANEL_WIDTH, window.innerWidth - 100);
      const w = Math.max(MIN_PANEL_WIDTH, Math.min(max, s.startWidth + (s.startX - e.clientX)));
      setWidth(w);
    };
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // 拖拽期间全局保持列调整光标
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
  }, [resizing]);

  // 挂载时加载该画布的持久化对话历史（组件按 canvasId 重挂载，天然隔离）
  useEffect(() => {
    if (!canvasId) return;
    getChatHistory(canvasId)
      .then((messages) => {
        setEntries(
          messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: 0, // 历史不展示时间戳
          }))
        );
      })
      .catch(() => {
        // 后端未就绪时静默，面板仍可输入
      });
  }, [canvasId]);

  // 新消息时滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, sending, open]);

  // 两段式清空确认 3 秒后自动复位
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const handleClear = async () => {
    if (!canvasId) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    try {
      await clearChatHistory(canvasId);
    } catch {
      // 清空失败不阻断本地清空展示
    }
    setEntries([]);
    setInput("");
    setConfirmClear(false);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !canvasId || sending) return;
    setInput("");
    setSending(true);
    setEntries((prev) => [
      ...prev,
      { role: "user", content: text, timestamp: Date.now() },
    ]);

    try {
      const res = await chatWithAgent(canvasId, text);
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.message,
          steps: res.steps,
          timestamp: Date.now(),
        },
      ]);
      // Agent 可能改了画布（生成/移动/删除节点），通知上层刷新
      onCanvasUpdate(res.canvas);
    } catch (e) {
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `请求失败：${(e as Error).message}（请检查后端与模型配置）`,
          timestamp: Date.now(),
          error: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  // 收起时浮动按钮（右下角）
  if (!open) {
    return (
      <div
        onClick={() => toggleOpen(true)}
        style={{
          position: "fixed",
          right: 20,
          bottom: 24,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(99,102,241,0.95)",
          border: "1px solid rgba(255,255,255,0.2)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          cursor: "pointer",
          zIndex: 1000,
          userSelect: "none",
        }}
        title="打开 AI 对话"
      >
        💬
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 68,
        right: 16,
        bottom: 16,
        width,
        background: "rgba(26,26,46,0.97)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(8px)",
        overflow: "hidden",
        // 拖拽期间禁用内容选择，避免拉伸时选中文字
        userSelect: resizing ? "none" : "auto",
      }}
    >
      {/* 左边缘拖拽热区（透明，悬停/拖拽时才显示竖线提示） */}
      <div
        onMouseDown={startResize}
        onMouseEnter={() => setHoverHandle(true)}
        onMouseLeave={() => setHoverHandle(false)}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 8,
          cursor: "col-resize",
          zIndex: 10,
        }}
        title="拖动调整面板宽度"
      >
        <div
          style={{
            position: "absolute",
            left: 2,
            top: 0,
            bottom: 0,
            width: 3,
            borderRadius: 2,
            background: resizing
              ? "rgba(99,102,241,0.8)"
              : hoverHandle
                ? "rgba(255,255,255,0.25)"
                : "transparent",
            transition: "background 0.15s ease",
          }}
        />
      </div>

      {/* 标题栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ color: "#ddd", fontSize: 14, fontWeight: 600 }}>
          💬 AI 对话
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            onClick={handleClear}
            style={{
              color: confirmClear ? "#f87171" : "#888",
              fontSize: 12,
              cursor: "pointer",
              userSelect: "none",
              padding: "2px 6px",
            }}
            title="清空当前画布的对话历史"
          >
            {confirmClear ? "确认清空？" : "清空"}
          </span>
          <span
            onClick={() => toggleOpen(false)}
            style={{
              color: "#888",
              fontSize: 14,
              cursor: "pointer",
              userSelect: "none",
              padding: "2px 6px",
            }}
            title="收起面板"
          >
            收起 »
          </span>
        </div>
      </div>

      {/* 消息列表 */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {entries.length === 0 && !sending && (
          <div
            style={{
              color: "#777",
              fontSize: 13,
              textAlign: "center",
              padding: "28px 12px",
              lineHeight: 1.8,
            }}
          >
            向 AI 助手下达画布指令，例如：
            <br />
            「生成一张大熊猫图片」
            <br />
            「把第一张图向右移动 200」
            <br />
            「合并所有图片成一张」
          </div>
        )}

        {entries.map((entry, i) =>
          entry.role === "user" ? (
            /* 用户消息：右对齐气泡 */
            <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  maxWidth: "86%",
                  background: "rgba(99,102,241,0.85)",
                  color: "#fff",
                  padding: "8px 12px",
                  borderRadius: "12px 12px 2px 12px",
                  fontSize: 14,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {entry.content}
              </div>
            </div>
          ) : (
            /* Agent 回复：左对齐气泡 + 工具调用过程 */
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "92%",
                  background: "rgba(255,255,255,0.07)",
                  color: entry.error ? "#f87171" : "#e8e8f0",
                  padding: "8px 12px",
                  borderRadius: "12px 12px 12px 2px",
                  fontSize: 14,
                  lineHeight: 1.6,
                  wordBreak: "break-word",
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {entry.content}
                </ReactMarkdown>
              </div>

              {/* 工具调用步骤（仅本轮对话展示） */}
              {entry.steps && entry.steps.some((s) => s.type === "tool_call") && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "92%",
                    width: "92%",
                    background: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {entry.steps
                    .filter((s) => s.type === "tool_call")
                    .map((s, j) => (
                      <div
                        key={j}
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            background: "rgba(99,102,241,0.2)",
                            color: "#a5b4fc",
                            padding: "1px 8px",
                            borderRadius: 4,
                            fontSize: 11,
                            flexShrink: 0,
                          }}
                        >
                          {TOOL_LABELS[s.tool || ""] || s.tool}
                        </span>
                        <span
                          style={{
                            color: "#888",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={s.result || ""}
                        >
                          {s.result || ""}
                        </span>
                      </div>
                    ))}
                </div>
              )}

              {entry.timestamp > 0 && (
                <span style={{ color: "#555", fontSize: 11, paddingLeft: 4 }}>
                  {formatTime(entry.timestamp)}
                </span>
              )}
            </div>
          )
        )}

        {/* 思考中指示 */}
        {sending && (
          <div style={{ display: "flex", gap: 4, paddingLeft: 6, alignItems: "center" }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#888",
                  animation: `chatblink 1.2s ${i * 0.2}s infinite`,
                }}
              />
            ))}
            <span style={{ color: "#888", fontSize: 12, marginLeft: 4 }}>
              Agent 正在思考与调用工具...
            </span>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          padding: 10,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
            // Shift+Enter 换行
          }}
          rows={2}
          placeholder={
            canvasId ? "输入指令，Enter 发送，Shift+Enter 换行" : "画布加载中..."
          }
          disabled={!canvasId || sending}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            color: "#eee",
            fontSize: 14,
            padding: "8px 10px",
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || !canvasId || sending}
          style={{
            background: sending || !input.trim() || !canvasId ? "rgba(99,102,241,0.35)" : "rgba(99,102,241,0.95)",
            border: "none",
            color: "#fff",
            borderRadius: 10,
            padding: "10px 16px",
            fontSize: 14,
            cursor: sending || !input.trim() || !canvasId ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          发送
        </button>
      </div>

      <style>{`
        @keyframes chatblink {
          0%, 60%, 100% { opacity: 0.25; }
          30% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
