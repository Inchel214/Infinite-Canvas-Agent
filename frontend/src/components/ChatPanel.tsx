import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chatWithAgentStream,
  getChatHistory,
  clearChatHistory,
  stopAgent,
} from "../api/agent";
import type { AgentStep, CanvasNode, CanvasState } from "../types/canvas";

// 面板内展示条目：历史消息不含 steps（后端只存文本对），本轮对话带工具调用过程
interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  plan?: string; // 执行计划（流式 plan 事件，展示为路线图卡片）
  reasoning?: string; // 深度思考过程（reasoning_content 流，与正文分离）
  reasoningOpen?: boolean; // 思考区展开态：思考中自动展开，正文开始自动折叠
  stopped?: boolean; // 用户中途停止
  timestamp: number;
  error?: boolean;
}

interface ChatReference {
  id: string;
  label: string;
  content?: string;
  imageUrl?: string;
}

interface ChatPanelProps {
  canvasId: string | null;
  // 面板开合（受控，状态在 App：添加引用时可自动弹出）
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 面板宽度（受控，状态在 App：画布层的缩放指示器需据此避让）
  width: number;
  onWidthChange: (w: number) => void;
  // 右键"添加到对话"引用的图片（App 从画布状态解析，作为待插入收件箱）
  refNodes: CanvasNode[];
  // 当前画布全部节点：用于恢复历史消息中已持久化的引用缩略图
  canvasNodes: CanvasNode[];
  onClearRefs: () => void;
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

// 引用标记：与后端 Agent/历史持久化契约保持一致。行内出现（位置即语义），可位于文本任意处
const REF_INLINE_RE = /\[引用图片\s+(\S+)[\s\S]*?\(node_id=([^)]+)\)\]/g;

// 用户消息展示段落：文本与图片引用芯片交替，气泡按原位置渲染
type DisplaySegment =
  | { type: "text"; text: string }
  | { type: "image"; ref: ChatReference };

/**
 * 把含行内引用标记的用户消息解析成展示段落。
 * 节点已被删除时回退到标记里的持久化标签（无缩略图）。
 */
function parseMessageSegments(
  content: string,
  nodeById: Map<string, CanvasNode>
): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let last = 0;
  for (const m of content.matchAll(REF_INLINE_RE)) {
    if (m.index > last) segments.push({ type: "text", text: content.slice(last, m.index) });
    const [, persistedLabel, nodeId] = m;
    const node = nodeById.get(nodeId);
    segments.push({
      type: "image",
      ref: {
        id: nodeId,
        label: node?.index != null ? `#${node.index}` : persistedLabel,
        content: node?.content,
        imageUrl: node?.image_url,
      },
    });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: "text", text: content.slice(last) });
  // 压缩夹在芯片之间或贴边的纯空白文本段（旧格式标记逐行堆叠会残留 "\n" 段）
  return segments.filter((seg, i) => {
    if (seg.type !== "text" || seg.text.trim() !== "") return true;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    if (!prev || !next) return false;
    return !(prev.type === "image" && next.type === "image");
  });
}

// 芯片 → 发送给 Agent 的标记文本（格式与旧版逐行前置完全一致，仅位置改为行内）
function chipMarker(dataset: DOMStringMap): string {
  const label = dataset.label || "图";
  const desc = dataset.content ? `「${dataset.content.slice(0, 60)}」` : "";
  return `[引用图片 ${label} ${desc}(node_id=${dataset.nodeId})]`;
}

/**
 * 序列化编辑器内容为纯文本：文本原样保留，引用芯片在原位置展开为标记。
 * 兼容浏览器产生的 <br> 与 <div>/<p> 块级换行。
 */
function serializeEditor(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.nodeId) {
      out += chipMarker(node.dataset);
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && out && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
    if (isBlock && !out.endsWith("\n")) out += "\n";
  };
  root.childNodes.forEach(walk);
  return out;
}

// 构建输入框内的引用芯片（DOM 直建，脱离 React 渲染，避免 contenteditable 光标问题）
function buildRefChip(node: CanvasNode): HTMLElement {
  const label = node.index != null ? `#${node.index}` : node.id.slice(0, 8);
  const chip = document.createElement("span");
  chip.className = "ref-chip";
  chip.contentEditable = "false"; // 作为原子单位参与编辑：Backspace 整体删除
  chip.dataset.nodeId = node.id;
  chip.dataset.label = label;
  if (node.content) chip.dataset.content = node.content;
  chip.title = node.content || "引用图片";
  if (node.image_url) {
    const img = document.createElement("img");
    img.src = node.image_url;
    img.alt = label;
    chip.appendChild(img);
  }
  const text = document.createElement("span");
  text.textContent = label;
  chip.appendChild(text);
  const remove = document.createElement("span");
  remove.className = "ref-chip-remove";
  remove.textContent = "✕";
  remove.title = "移除引用";
  chip.appendChild(remove);
  return chip;
}

// 在光标处插入节点（光标不在编辑器内时追加到末尾），插入后光标落到节点之后
function insertAtCursor(root: HTMLElement, el: HTMLElement) {
  root.focus();
  const sel = window.getSelection();
  let range: Range | null = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || !root.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(el);
  range.setStartAfter(el);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// 粘贴纯文本：execCommand 虽已废弃，但能并入 contenteditable 原生撤销栈，浏览器支持最好
function insertTextAtCursor(root: HTMLElement, text: string) {
  root.focus();
  if (!document.execCommand("insertText", false, text)) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export function ChatPanel({
  canvasId,
  open,
  onOpenChange,
  width,
  onWidthChange,
  refNodes,
  canvasNodes,
  onClearRefs,
  onCanvasUpdate,
}: ChatPanelProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // 输入区是否有内容（文本或引用芯片）：驱动发送按钮禁用态
  const [hasContent, setHasContent] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hoverHandle, setHoverHandle] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 渲染期解析引用标记（含历史消息）：节点可能后被删除，查找失败回退到持久化标签
  const nodeById = useMemo(
    () => new Map(canvasNodes.map((n) => [n.id, n])),
    [canvasNodes]
  );

  // 输入事件后同步空态/有内容状态；浏览器会在清空的 contenteditable 里留 <br>，归一化为空让 :empty 占位符生效
  const syncEditorState = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!editor.textContent?.trim() && !editor.querySelector("[data-node-id]")) {
      editor.innerHTML = "";
      setHasContent(false);
    } else {
      setHasContent(true);
    }
  };

  // 消费 App 侧"添加到对话"收件箱：引用以芯片形式插入光标处（位置即语义），随后清空收件箱
  useEffect(() => {
    if (refNodes.length === 0 || !open) return;
    const editor = editorRef.current;
    if (!editor) return;
    const fresh = refNodes.filter((n) => !editor.querySelector(`[data-node-id="${n.id}"]`));
    fresh.forEach((n) => insertAtCursor(editor, buildRefChip(n)));
    if (fresh.length > 0) setHasContent(true);
    onClearRefs();
  }, [refNodes, open, onClearRefs]);

  // 画布节点被删除时同步移除编辑器里的失效芯片，避免发出不存在的引用
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || canvasNodes.length === 0) return;
    editor.querySelectorAll("[data-node-id]").forEach((el) => {
      if (!nodeById.has((el as HTMLElement).dataset.nodeId || "")) el.remove();
    });
    syncEditorState();
  }, [nodeById]);

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
      onWidthChange(w);
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

  // 挂载时加载该画布的持久化对话历史（组件按 canvasId 重挂载，天然隔离）。
  // 历史里的行内引用标记在渲染气泡时还原成芯片（见 renderUserContent）
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
    const editor = editorRef.current;
    if (editor) editor.innerHTML = "";
    setHasContent(false);
    setConfirmClear(false);
  };

  // 用户气泡：按行内标记把引用还原成芯片，与发送时的输入版式一致
  const renderUserContent = (content: string) =>
    parseMessageSegments(content, nodeById).map((seg, i) =>
      seg.type === "text" ? (
        <span key={i}>{seg.text}</span>
      ) : (
        <span key={i} className="msg-ref-chip" title={seg.ref.content || "引用图片"}>
          {seg.ref.imageUrl && <img src={seg.ref.imageUrl} alt={seg.ref.label} />}
          <span>{seg.ref.label}</span>
        </span>
      )
    );

  const handleSend = async () => {
    const editor = editorRef.current;
    if (!editor || !canvasId || sending) return;
    // 序列化编辑器：文本原样保留，引用芯片在原位置展开为 [引用图片 ...] 标记。
    // 本地气泡与历史持久化共用这份文本，渲染时再解析回芯片
    const message = serializeEditor(editor).trim();
    if (!message) return;
    editor.innerHTML = "";
    setHasContent(false);
    // 引用已随消息序列化，清空 App 侧收件箱避免残留
    onClearRefs();
    setSending(true);
    const ts = Date.now();
    // 立刻挂一条空的 assistant 条目作为"直播位"，流式事件逐步填充它
    setEntries((prev) => [
      ...prev,
      { role: "user", content: message, timestamp: ts },
      { role: "assistant", content: "", steps: [], timestamp: ts },
    ]);

    // 更新直播条目（entries 末尾那条 assistant）
    const updateLive = (patch: (e: ChatEntry) => ChatEntry) => {
      setEntries((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        const next = [...prev];
        next[next.length - 1] = patch(last);
        return next;
      });
    };

    try {
      await chatWithAgentStream(canvasId, message, (evt) => {
        if (evt.type === "plan_delta" && evt.content) {
          // 计划逐字流出（打字机），追加渲染
          updateLive((e) => ({ ...e, plan: (e.plan || "") + evt.content }));
        } else if (evt.type === "reasoning_delta" && evt.content) {
          // 深度思考过程实时流出：自动展开思考区（正文开始后折叠）
          updateLive((e) => ({
            ...e,
            reasoning: (e.reasoning || "") + evt.content,
            reasoningOpen: true,
          }));
        } else if (evt.type === "delta" && evt.content) {
          // LLM 正文逐字流出；正文一出现就把思考区折叠起来
          updateLive((e) => ({
            ...e,
            content: (e.content || "") + evt.content,
            reasoningOpen: e.reasoning ? false : e.reasoningOpen,
          }));
        } else if (evt.type === "tool_start") {
          updateLive((e) => ({
            ...e,
            steps: [
              ...(e.steps || []),
              { type: "tool_call", tool: evt.tool, args: evt.args, result: "", pending: true },
            ],
          }));
        } else if (evt.type === "tool_result") {
          // 画布随工具执行增量刷新：生成的图片立刻出现在画布上
          if (evt.canvas) onCanvasUpdate(evt.canvas);
          updateLive((e) => {
            const steps = [...(e.steps || [])];
            for (let k = steps.length - 1; k >= 0; k--) {
              if (steps[k].pending) {
                steps[k] = {
                  ...steps[k],
                  result: evt.result || "",
                  success: evt.success,
                  pending: false,
                };
                break;
              }
            }
            return { ...e, steps };
          });
        } else if (evt.type === "done") {
          updateLive((e) => ({
            ...e,
            content: evt.message || e.content,
            steps: evt.steps || e.steps,
            stopped: evt.stopped,
            error: !evt.success && !evt.stopped,
          }));
          if (evt.canvas) onCanvasUpdate(evt.canvas);
        }
        // start / response 事件无需单独处理（response 与 done.message 一致）
      });
    } catch (e) {
      updateLive((live) => ({
        ...live,
        content: `请求失败：${(e as Error).message}（请检查后端与模型配置）`,
        error: true,
      }));
    } finally {
      setSending(false);
    }
  };

  // 停止当前执行：后端在下一个操作边界中断，done 事件（stopped）到达后 UI 复位
  const handleStop = async () => {
    if (!canvasId) return;
    try {
      await stopAgent(canvasId);
    } catch {
      // 停止请求失败时忽略，等待流自然结束
    }
  };

  // 收起时浮动按钮（右下角）
  if (!open) {
    return (
      <div
        onClick={() => onOpenChange(true)}
        style={{
          position: "fixed",
          right: 20,
          bottom: 52, // 让开右下角钉住的缩放百分比指示器（约 24px 高 + 间距）
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
      data-role="chat-panel"
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
            onClick={() => onOpenChange(false)}
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
            /* 用户消息：右对齐气泡（引用以行内芯片还原在原文位置） */
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}
            >
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
                {renderUserContent(entry.content)}
              </div>
            </div>
          ) : (
            /* Agent 回复：执行计划卡片 + 左对齐气泡 + 工具调用过程 */
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* 执行计划（规划阶段流式产出，工具执行期间就能看到路线图） */}
              {entry.plan && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "92%",
                    width: "92%",
                    background: "rgba(99,102,241,0.08)",
                    border: "1px dashed rgba(99,102,241,0.45)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    fontSize: 12.5,
                    color: "#c7d2fe",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>📋 执行计划</div>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {entry.plan}
                  </ReactMarkdown>
                </div>
              )}

              {/* 深度思考过程（执行阶段保留思考，实时流式可见；正文开始自动折叠，可点击回看） */}
              {entry.reasoning && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "92%",
                    width: "92%",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "#8b8b9a",
                    overflow: "hidden",
                  }}
                >
                  <div
                    onClick={() =>
                      setEntries((prev) =>
                        prev.map((e2, j) =>
                          j === i ? { ...e2, reasoningOpen: !e2.reasoningOpen } : e2
                        )
                      )
                    }
                    style={{
                      padding: "5px 10px",
                      cursor: "pointer",
                      userSelect: "none",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>🧠</span>
                    <span>
                      {entry.content ? "已深度思考（点击回看）" : "正在思考…"}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 10 }}>
                      {entry.reasoningOpen ? "▼" : "▶"}
                    </span>
                  </div>
                  {entry.reasoningOpen && (
                    <div
                      style={{
                        padding: "0 10px 6px",
                        borderTop: "1px solid rgba(255,255,255,0.06)",
                        paddingTop: 5,
                        maxHeight: 200,
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.55,
                      }}
                    >
                      {entry.reasoning}
                    </div>
                  )}
                </div>
              )}

              {entry.content && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "92%",
                    background: "rgba(255,255,255,0.07)",
                    color: entry.error ? "#f87171" : entry.stopped ? "#fbbf24" : "#e8e8f0",
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
              )}

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
                            background: s.pending
                              ? "rgba(99,102,241,0.35)"
                              : "rgba(99,102,241,0.2)",
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
                            color: s.pending
                              ? "#818cf8"
                              : s.success === false
                                ? "#f87171"
                                : "#888",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            animation: s.pending ? "chatblink 1.2s infinite" : undefined,
                          }}
                          title={s.result || ""}
                        >
                          {s.pending ? "执行中..." : (s.result || "")}
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

      {/* 输入区：contenteditable 富文本，引用图片以行内芯片混排在文字中 */}
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          padding: 10,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <div
          ref={editorRef}
          className="chat-editor"
          contentEditable={!!canvasId && !sending}
          suppressContentEditableWarning
          data-placeholder={
            canvasId ? "输入指令，Enter 发送，Shift+Enter 换行" : "画布加载中..."
          }
          onInput={syncEditorState}
          onKeyDown={(e) => {
            // 中文输入法组词期间的 Enter 是选词，不触发发送
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
              return;
            }
            // Shift+Enter 换行（浏览器原生行为）
            // JS 放置的光标紧贴芯片时，浏览器原生 Backspace/Delete 常常不响应，
            // 手动识别相邻芯片并整体删除
            if (e.key === "Backspace" || e.key === "Delete") {
              const editor = editorRef.current;
              const sel = window.getSelection();
              if (!editor || !sel || !sel.isCollapsed || sel.rangeCount === 0) return;
              const { startContainer, startOffset } = sel.getRangeAt(0);
              let candidate: Node | null = null;
              if (startContainer.nodeType === Node.ELEMENT_NODE) {
                candidate =
                  e.key === "Backspace"
                    ? startContainer.childNodes[startOffset - 1]
                    : startContainer.childNodes[startOffset];
              } else if (startContainer.nodeType === Node.TEXT_NODE) {
                if (e.key === "Backspace" && startOffset === 0) {
                  candidate = startContainer.previousSibling;
                } else if (
                  e.key === "Delete" &&
                  startOffset === (startContainer.textContent?.length ?? 0)
                ) {
                  candidate = startContainer.nextSibling;
                }
              }
              if (candidate instanceof HTMLElement && candidate.classList.contains("ref-chip")) {
                e.preventDefault();
                candidate.remove();
                syncEditorState();
              }
            }
          }}
          onPaste={(e) => {
            // 只接受纯文本，避免粘贴进来的富文本破坏芯片结构
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (text && editorRef.current) insertTextAtCursor(editorRef.current, text);
          }}
          onClick={(e) => {
            // 事件委托处理芯片上的 ✕ 移除按钮
            const removeBtn = (e.target as HTMLElement).closest(".ref-chip-remove");
            if (removeBtn) {
              removeBtn.closest(".ref-chip")?.remove();
              syncEditorState();
            }
          }}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            color: "#eee",
            fontSize: 14,
            padding: "8px 10px",
            outline: "none",
            fontFamily: "inherit",
            // 固定行高 22px，芯片高 20px：所有行保持同一高度，不因芯片起伏
            lineHeight: "22px",
            minHeight: 60,
            maxHeight: 126,
            overflowY: "auto",
            boxSizing: "border-box",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            opacity: !canvasId || sending ? 0.55 : 1,
          }}
        />
        {sending ? (
          /* 执行中可随时中断：后端在下一个操作边界停止，done(stopped) 事件到达后复位 */
          <button
            onClick={handleStop}
            style={{
              background: "rgba(248,113,113,0.92)",
              border: "none",
              color: "#fff",
              borderRadius: 10,
              padding: "10px 16px",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
            title="停止当前正在执行的 Agent 任务"
          >
            停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasContent || !canvasId}
            style={{
              background: !hasContent || !canvasId ? "rgba(99,102,241,0.35)" : "rgba(99,102,241,0.95)",
              border: "none",
              color: "#fff",
              borderRadius: 10,
              padding: "10px 16px",
              fontSize: 14,
              cursor: !hasContent || !canvasId ? "default" : "pointer",
              flexShrink: 0,
            }}
          >
            发送
          </button>
        )}
      </div>

      <style>{`
        @keyframes chatblink {
          0%, 60%, 100% { opacity: 0.25; }
          30% { opacity: 1; }
        }
        /* 输入框占位符（contenteditable 无原生 placeholder） */
        .chat-editor:empty::before {
          content: attr(data-placeholder);
          color: #777;
          pointer-events: none;
        }
        /* 输入框内的引用芯片：高 20px ≤ 行高 22px，垂直居中，保证各行高度一致 */
        .ref-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          box-sizing: border-box;
          height: 20px;
          padding: 0 3px 0 2px;
          background: rgba(99,102,241,0.22);
          border: 1px solid rgba(99,102,241,0.55);
          border-radius: 6px;
          margin: 0 2px;
          vertical-align: middle;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          color: #c7d2fe;
          user-select: none;
        }
        .ref-chip img {
          width: 16px;
          height: 16px;
          object-fit: cover;
          border-radius: 3px;
        }
        .ref-chip-remove {
          cursor: pointer;
          color: #8f8fb0;
          font-size: 11px;
          padding: 2px 3px;
          border-radius: 4px;
          line-height: 1;
        }
        .ref-chip-remove:hover {
          color: #fff;
          background: rgba(248,113,113,0.85);
        }
        /* 用户气泡内的引用芯片（只读展示，无移除按钮） */
        .msg-ref-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          box-sizing: border-box;
          height: 20px;
          padding: 0 6px 0 2px;
          background: rgba(255,255,255,0.16);
          border: 1px solid rgba(255,255,255,0.35);
          border-radius: 6px;
          margin: 0 2px;
          vertical-align: middle;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
        }
        .msg-ref-chip img {
          width: 16px;
          height: 16px;
          object-fit: cover;
          border-radius: 3px;
        }
      `}</style>
    </div>
  );
}
