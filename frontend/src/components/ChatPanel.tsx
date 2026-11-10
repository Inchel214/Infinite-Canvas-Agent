import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chatWithAgentStream,
  getChatHistory,
  clearChatHistory,
  stopAgent,
  respondToAgent,
  getStreamSnapshot,
  beginRound,
  undoRound,
  type AgentStreamEvent,
} from "../api/agent";
import type { CanvasNode, CanvasState, ChatMessage, RunRecord, TimelineSegment } from "../types/canvas";

// assistant 条目的时间线段：按发生顺序渲染（计划/思考/文本/工具自然穿插）
type Segment =
  | { kind: "plan"; text: string }
  | { kind: "reasoning"; text: string; open: boolean }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      tool: string;
      args?: Record<string, unknown>;
      result: string;
      success?: boolean;
      pending: boolean;
    };

// 面板内展示条目：assistant 携带时间线段（实时流/回放/历史 timeline 三条路径统一结构）
interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  // assistant：时间线段（计划/思考/文本/工具按发生顺序排列）
  segments?: Segment[];
  // assistant：直播中标记（done/异常后置 false）；忙碌判断与思考指示据此派生
  live?: boolean;
  // user：排队中（等待 steering 注入或下一轮执行）
  queued?: boolean;
  stopped?: boolean; // 用户中途停止
  error?: boolean;
  roundId?: string; // 轮次标记 ID（用于整轮撤回）
  // 人在回路：Agent 询问用户
  askUser?: {
    question: string;
    options?: string[];
    timeout?: number; // 超时时间（秒）
    default_action?: string; // 超时后的默认行为
    startTime?: number; // 开始等待的时间戳
    answered?: boolean; // 用户是否已回复
    response?: string; // 用户的回复
  };
}

interface ChatReference {
  id: string;
  label: string;
  content?: string;
  imageUrl?: string;
}

/** 找到 tail 中最后一个 assistant 条目的下标（直播位） */
function lastAssistantIndex(tail: ChatEntry[]): number {
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].role === "assistant") return i;
  }
  return -1;
}

/** 更新 tail 中最后一个 assistant 条目 */
function patchLive(
  tail: ChatEntry[],
  patch: (e: ChatEntry) => ChatEntry
): ChatEntry[] {
  const idx = lastAssistantIndex(tail);
  if (idx < 0) return tail;
  const next = [...tail];
  next[idx] = patch(next[idx]);
  return next;
}

/** 向条目追加一个时间线段；连续同类文本段合并（token 级增量归并） */
function appendSegment(entry: ChatEntry, seg: Segment): ChatEntry {
  const segs = [...(entry.segments || [])];
  const last = segs[segs.length - 1];
  if (
    last &&
    ((seg.kind === "text" && last.kind === "text") ||
      (seg.kind === "reasoning" && last.kind === "reasoning") ||
      (seg.kind === "plan" && last.kind === "plan"))
  ) {
    segs[segs.length - 1] = { ...last, text: last.text + seg.text } as Segment;
  } else {
    segs.push(seg);
  }
  return { ...entry, segments: segs };
}

function newLiveAssistant(): ChatEntry {
  return {
    role: "assistant",
    content: "",
    segments: [],
    timestamp: Date.now(),
    live: true,
  };
}

/**
 * 把单个流式事件应用到条目序列（纯函数，无副作用，返回新数组）。
 * 实时流与"切换画布后的回放"共用同一套归约逻辑，保证两种路径渲染一致。
 * 事件按时间顺序落为 segments：工具卡片自然穿插在文本流中，中间过程文本保留。
 *
 * 全量操作（非仅尾部）：多条消息排队时，被 steering 消费的排队气泡可能位于
 * 直播条目之后，新直播条目须插入"被消费的气泡之后"以保持
 * 「回复段 → 用户气泡 → 回复段」的时间顺序。
 */
function reduceStreamEvent(
  entries: ChatEntry[],
  evt: AgentStreamEvent
): ChatEntry[] {
  const content = (evt.content as string) || "";
  switch (evt.type) {
    case "run_start": {
      // 新一轮开始（队列推进）：清除本条消息的排队标记，并在该气泡后
      // 插入直播条目承接后续事件；无匹配气泡（单请求/回放路径）则在末尾补
      const next = [...entries];
      let bubbleIdx = -1;
      for (let i = 0; i < next.length; i++) {
        if (
          next[i].role === "user" &&
          next[i].queued &&
          (!content || next[i].content === content)
        ) {
          bubbleIdx = i;
          break;
        }
      }
      if (bubbleIdx >= 0) {
        next[bubbleIdx] = { ...next[bubbleIdx], queued: false };
        const after = next[bubbleIdx + 1];
        if (!after || after.role !== "assistant" || after.live === false) {
          next.splice(bubbleIdx + 1, 0, newLiveAssistant());
        }
        return next;
      }
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant" || last.live === false) {
        next.push(newLiveAssistant());
      }
      return next;
    }
    case "plan_delta":
      return content
        ? patchLive(entries, (e) => appendSegment(e, { kind: "plan", text: content }))
        : entries;
    case "reasoning_delta":
      return content
        ? patchLive(entries, (e) =>
            appendSegment(e, { kind: "reasoning", text: content, open: true })
          )
        : entries;
    case "delta":
      if (!content) return entries;
      return patchLive(entries, (e) => {
        // 正文开始：折叠正在展开的思考段
        let entry = e;
        if (entry.segments?.some((s) => s.kind === "reasoning" && s.open)) {
          entry = {
            ...entry,
            segments: entry.segments.map((s) =>
              s.kind === "reasoning" ? { ...s, open: false } : s
            ),
          };
        }
        return appendSegment(entry, { kind: "text", text: content });
      });
    case "tool_start":
      return patchLive(entries, (e) =>
        appendSegment(e, {
          kind: "tool",
          tool: evt.tool || "",
          args: evt.args,
          result: "",
          pending: true,
        })
      );
    case "tool_result":
      return patchLive(entries, (e) => {
        const segs = [...(e.segments || [])];
        for (let k = segs.length - 1; k >= 0; k--) {
          const s = segs[k];
          if (s.kind === "tool" && s.pending) {
            segs[k] = {
              ...s,
              result: evt.result || "",
              success: evt.success,
              pending: false,
            };
            break;
          }
        }
        return { ...e, segments: segs };
      });
    case "user_message": {
      // 排队消息被 steering 注入当前回合：
      // 1) 全量查找其排队气泡清除标记（回放路径无匹配则在定稿条目后补气泡）
      // 2) 当前直播条目定稿
      // 3) 新直播条目插入该气泡之后，承接注入后的 Agent 输出
      const next = [...entries];
      let bubbleIdx = -1;
      for (let i = 0; i < next.length; i++) {
        if (next[i].role === "user" && next[i].queued && next[i].content === content) {
          bubbleIdx = i;
          break;
        }
      }
      if (bubbleIdx >= 0) {
        next[bubbleIdx] = { ...next[bubbleIdx], queued: false };
      }
      const liveIdx = lastAssistantIndex(next);
      if (liveIdx >= 0 && next[liveIdx].live) {
        next[liveIdx] = { ...next[liveIdx], live: false };
      }
      if (bubbleIdx < 0) {
        bubbleIdx = liveIdx + 1;
        next.splice(bubbleIdx, 0, {
          role: "user",
          content,
          timestamp: Date.now(),
        });
      }
      next.splice(bubbleIdx + 1, 0, newLiveAssistant());
      return next;
    }
    case "ask_user":
      return patchLive(entries, (e) => ({
        ...e,
        askUser: {
          question: evt.question || "",
          options: evt.options,
          timeout: evt.timeout,
          default_action: evt.default_action,
          startTime: Date.now(),
        },
      }));
    case "response":
      return patchLive(entries, (e) => ({ ...e, content: evt.content || e.content }));
    case "done":
      return patchLive(entries, (e) => {
        let entry: ChatEntry = {
          ...e,
          content: evt.message || e.content,
          stopped: evt.stopped,
          error: !evt.success && !evt.stopped,
          live: false,
        };
        // 兜底：没有任何文本段但有最终回复（异常路径流内无 delta）→ 补文本段
        if (
          evt.message &&
          !(entry.segments || []).some((s) => s.kind === "text" && s.text)
        ) {
          entry = appendSegment(entry, { kind: "text", text: evt.message });
        }
        return entry;
      });
    default:
      return entries;
  }
}

/**
 * 历史消息 + 执行记录 → 面板条目序列。
 * assistant 消息优先按关联 run 的 timeline 展开（工具卡片穿插在文本流中），
 * 旧数据无 timeline 时用 steps 合成；steering 注入的用户消息由 timeline 锚点渲染。
 */
function buildHistoryEntries(
  messages: ChatMessage[],
  runs: RunRecord[]
): ChatEntry[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const entries: ChatEntry[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      // steering 注入的用户消息：独立气泡由对应 run 的 timeline 锚点渲染，跳过避免重复。
      // run 记录被裁剪丢失时兜底显示，避免消息丢失。
      if (m.steered_run_id && runById.has(m.steered_run_id)) continue;
      entries.push({
        role: "user",
        content: m.content,
        timestamp: 0,
        // 撤回标识随消息持久化：刷新/切换画布后撤回按钮依然可用
        roundId: m.round_id,
      });
      continue;
    }
    const run = m.run_id ? runById.get(m.run_id) : undefined;
    let timeline: TimelineSegment[] | null = null;
    if (run?.timeline?.length) {
      timeline = run.timeline;
    } else if (run?.steps?.length) {
      // 旧数据兼容：无 timeline 时用 steps 合成（计划 + 工具段 + 末尾回复段）
      timeline = [
        ...(run.plan ? [{ kind: "plan", text: run.plan } as TimelineSegment] : []),
        ...run.steps.map(
          (s) =>
            ({
              kind: "tool",
              tool: s.tool || "",
              args: s.args,
              result: s.result || "",
              success: s.success,
            }) as TimelineSegment
        ),
        ...(m.content ? [{ kind: "text", text: m.content } as TimelineSegment] : []),
      ];
    }
    if (!timeline) {
      entries.push({ role: "assistant", content: m.content, timestamp: 0 });
      continue;
    }
    // timeline → 条目序列（user 锚点把 assistant 拆成多段，中间夹用户气泡）
    let cur: ChatEntry = {
      role: "assistant",
      content: "",
      segments: [],
      timestamp: 0,
    };
    entries.push(cur);
    for (const seg of timeline) {
      if (seg.kind === "user") {
        entries.push({ role: "user", content: seg.text, timestamp: 0 });
        cur = { role: "assistant", content: "", segments: [], timestamp: 0 };
        entries.push(cur);
      } else if (seg.kind === "tool") {
        cur.segments!.push({ ...seg, pending: false });
      } else {
        cur.segments!.push({ ...seg } as Segment);
      }
    }
    cur.content = m.content;
  }
  return entries;
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
  ask_user: "询问用户",
};

// 人在回路：Agent 询问用户卡片
function AskUserCard({
  question,
  options,
  timeout,
  default_action,
  startTime,
  answered,
  response,
  onRespond,
}: {
  question: string;
  options?: string[];
  timeout?: number;
  default_action?: string;
  startTime?: number;
  answered?: boolean;
  response?: string;
  onRespond: (response: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [remaining, setRemaining] = useState(timeout || 120);

  // 倒计时效果
  useEffect(() => {
    if (answered || !startTime) return;
    
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const left = Math.max(0, (timeout || 120) - elapsed);
      setRemaining(left);
      
      if (left === 0) {
        clearInterval(interval);
      }
    }, 1000);
    
    return () => clearInterval(interval);
  }, [answered, startTime, timeout]);

  const handleSubmit = (value: string) => {
    if (!value.trim()) return;
    onRespond(value.trim());
    setInputValue("");
  };

  // 格式化倒计时显示
  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  // 倒计时颜色：最后 30 秒变红
  const countdownColor = remaining <= 30 ? "#ef4444" : remaining <= 60 ? "#f59e0b" : "#888";

  return (
    <div
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        width: "92%",
        background: "rgba(251,191,36,0.08)",
        border: "1px solid rgba(251,191,36,0.3)",
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>💬</span>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#fbbf24" }}>
            Agent 需要你的回复
          </span>
        </div>
        {!answered && startTime && (
          <span style={{ fontSize: 11, color: countdownColor, fontFamily: "monospace" }}>
            {formatCountdown(remaining)}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: "#e8e8f0", marginBottom: 10, lineHeight: 1.5 }}>
        {question}
      </div>
      {answered ? (
        <div
          style={{
            fontSize: 12,
            color: "#888",
            padding: "6px 10px",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 6,
          }}
        >
          已回复：{response}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* 选项按钮（如果有） */}
          {options && options.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => handleSubmit(opt)}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    background: "rgba(99,102,241,0.2)",
                    border: "1px solid rgba(99,102,241,0.4)",
                    borderRadius: 6,
                    color: "#c7d2fe",
                    cursor: "pointer",
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          {/* 自由输入框（始终显示） */}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSubmit(inputValue);
                }
              }}
              placeholder={options && options.length > 0 ? "或输入自定义回复..." : "输入你的回复..."}
              style={{
                flex: 1,
                padding: "6px 10px",
                fontSize: 12,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#e8e8f0",
                outline: "none",
              }}
            />
            <button
              onClick={() => handleSubmit(inputValue)}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                background: "rgba(99,102,241,0.8)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              发送
            </button>
          </div>
          {/* 超时提示 */}
          {timeout && (
            <div style={{ fontSize: 11, color: "#666", fontStyle: "italic" }}>
              {default_action 
                ? `⏱ ${Math.floor(timeout / 60)} 分钟未回复将自动：${default_action}`
                : `⏱ ${Math.floor(timeout / 60)} 分钟未回复将由 Agent 自行决策`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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

/** 把含换行的纯文本写入 contenteditable（\n 还原为 <br>），用于撤回后回填输入框 */
function appendTextWithBreaks(root: HTMLElement, text: string) {
  text.split("\n").forEach((part, idx) => {
    if (idx > 0) root.appendChild(document.createElement("br"));
    if (part) root.appendChild(document.createTextNode(part));
  });
}

// 芯片 → 发送给 Agent 的标记文本（格式与旧版逐行前置完全一致，仅位置改为行内）
function chipMarker(dataset: DOMStringMap): string {
  const label = dataset.label || "图";
  const desc = dataset.content ? `「${dataset.content.slice(0, 60)}」` : "";
  return `[引用图片 ${label} ${desc}(node_id=${dataset.nodeId})]`;
}

/**
 * 序列化编辑器内容为文本 + 引用图片列表。
 * 文本：原样保留，引用芯片在原位置展开为标记。
 * 引用图片列表：包含 node_id 和 image_url，供 Vision 能力使用。
 * 兼容浏览器产生的 <br> 与 <div>/<p> 块级换行。
 */
function serializeEditor(root: HTMLElement): {
  text: string;
  referencedImages: Array<{ node_id: string; image_url: string }>;
} {
  let out = "";
  const referencedImages: Array<{ node_id: string; image_url: string }> = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.nodeId) {
      out += chipMarker(node.dataset);
      // 收集引用图片信息（如果有 image_url）
      if (node.dataset.imageUrl) {
        referencedImages.push({
          node_id: node.dataset.nodeId,
          image_url: node.dataset.imageUrl,
        });
      }
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
  return { text: out, referencedImages };
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
  if (node.image_url) chip.dataset.imageUrl = node.image_url; // 存储图片 URL 供 Vision 使用
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
  const spacer = document.createTextNode(" ");
  el.after(spacer);
  range.setStart(spacer, 1);
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

export interface ChatPanelRef {
  saveDraft: () => void;
}

export const ChatPanel = forwardRef<ChatPanelRef, ChatPanelProps>(function ChatPanel({
  canvasId,
  open,
  onOpenChange,
  width,
  onWidthChange,
  refNodes,
  canvasNodes,
  onClearRefs,
  onCanvasUpdate,
}: ChatPanelProps, ref) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // 输入区是否有内容（文本或引用芯片）：驱动发送按钮禁用态
  const [hasContent, setHasContent] = useState(false);
  // “@数字”引用菜单：null 表示关闭，空字符串表示刚输入 @、展示全部画布图片
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hoverHandle, setHoverHandle] = useState(false);
  const [, setDraftContent] = useState<string>("");
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);
  const panelDragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // 已消费的最大事件序号：steering 后后端把同一事件广播给所有订阅者，
  // 同一面板的并发 SSE 连接会重复投递，按 _seq 跳过重复（序号全局递增）
  const lastSeqRef = useRef(0);
  // 后端进程启动标识：重启后 _seq 归零，检测到变化时重置去重水位
  const lastBootRef = useRef<string | null>(null);

  // Agent 是否执行中（存在直播中的 assistant 条目）：思考指示/停止按钮据此显示。
  // 执行中用户可继续输入，消息进入队列（steering 注入或下一轮执行）。
  const sending = entries.some((e) => e.role === "assistant" && e.live);

  // 暴露 saveDraft 方法给父组件（保留接口兼容性，实际草稿已实时保存）
  useImperativeHandle(ref, () => ({
    saveDraft: () => {
      // 草稿已通过 syncEditorState 实时保存，无需额外操作
    },
  }), []);

  // 应用单个流式事件：画布增量刷新 + 全量归约条目序列。
  // 排队气泡可能位于直播条目之后（多排队场景），故按全量归约而非仅尾部。
  const applyStreamEvent = (evt: AgentStreamEvent) => {
    // 多连接去重：steering 注入后同一事件会经多条 SSE 连接重复送达，按全局
    // 递增序号只消费首次到达的拷贝；无序号（回放/旧协议）不检查。
    // 后端重启序号归零：_boot 变化时先重置水位，避免新事件被旧水位误跳过
    if (typeof evt._seq === "number") {
      if (evt._boot && evt._boot !== lastBootRef.current) {
        lastBootRef.current = evt._boot;
        lastSeqRef.current = 0;
      }
      if (evt._seq <= lastSeqRef.current) return;
      lastSeqRef.current = evt._seq;
    }
    if ((evt.type === "tool_result" || evt.type === "done") && evt.canvas) {
      onCanvasUpdate(evt.canvas);
    }
    setEntries((prev) => reduceStreamEvent(prev, evt));
  };

  useEffect(() => {
    if (!panelDragging) return;
    const move = (event: MouseEvent) => {
      const start = panelDragRef.current;
      const rect = panelRef.current?.getBoundingClientRect();
      if (!start || !rect) return;
      setPanelPosition({
        x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, start.left + event.clientX - start.x)),
        y: Math.max(8, Math.min(window.innerHeight - rect.height - 8, start.top + event.clientY - start.y)),
      });
    };
    const stop = () => { panelDragRef.current = null; setPanelDragging(false); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [panelDragging]);

  useEffect(() => {
    const clamp = () => setPanelPosition((position) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!position || !rect) return position;
      return { x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, position.x)),
        y: Math.max(8, Math.min(window.innerHeight - rect.height - 8, position.y)) };
    });
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [width, open]);

  // 渲染期解析引用标记（含历史消息）：节点可能后被删除，查找失败回退到持久化标签
  const nodeById = useMemo(
    () => new Map(canvasNodes.map((n) => [n.id, n])),
    [canvasNodes]
  );

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return canvasNodes
      .filter(
        (node) =>
          node.type === "image" &&
          !!node.image_url &&
          node.index != null &&
          String(node.index).includes(mentionQuery)
      )
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }, [canvasNodes, mentionQuery]);

  const closeMentionMenu = () => {
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setMentionIndex(0);
  };

  // 仅识别光标所在文本节点末尾的 @数字，避免误解析已插入的引用芯片。
  const updateMentionMenu = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.isCollapsed || selection.rangeCount === 0) {
      closeMentionMenu();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) {
      closeMentionMenu();
      return;
    }
    const beforeCaret = (range.startContainer.textContent || "").slice(0, range.startOffset);
    const match = beforeCaret.match(/@(\d*)$/);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const mentionRange = document.createRange();
    mentionRange.setStart(range.startContainer, range.startOffset - match[0].length);
    mentionRange.setEnd(range.startContainer, range.startOffset);
    mentionRangeRef.current = mentionRange;
    setMentionQuery(match[1]);
    setMentionIndex(0);
  };

  const selectMentionNode = (node: CanvasNode) => {
    const editor = editorRef.current;
    const range = mentionRangeRef.current;
    if (!editor || !range || !editor.contains(range.commonAncestorContainer)) return;
    editor.focus();
    range.deleteContents();
    const chip = buildRefChip(node);
    range.insertNode(chip);
    const caret = document.createRange();
    const spacer = document.createTextNode(" ");
    chip.after(spacer);
    caret.setStart(spacer, 1);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    setHasContent(true);
    closeMentionMenu();
  };

  // 输入事件后同步空态/有内容状态；浏览器会在清空的 contenteditable 里留 <br>，归一化为空让 :empty 占位符生效
  // 同时实时保存草稿到 localStorage，确保切换画布时不丢失
  const syncEditorState = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!editor.textContent?.trim() && !editor.querySelector("[data-node-id]")) {
      editor.innerHTML = "";
      setHasContent(false);
      setDraftContent("");
      // 实时清除草稿
      if (canvasId) {
        localStorage.removeItem(`chat_draft_${canvasId}`);
      }
    } else {
      const content = editor.innerHTML;
      setHasContent(true);
      setDraftContent(content);
      // 实时保存草稿
      if (canvasId && content && content !== '<br>') {
        localStorage.setItem(`chat_draft_${canvasId}`, content);
      }
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
    let removed = false;
    editor.querySelectorAll("[data-node-id]").forEach((el) => {
      if (!nodeById.has((el as HTMLElement).dataset.nodeId || "")) {
        el.remove();
        removed = true;
      }
    });
    // 只在有芯片被移除时才同步状态，避免组件挂载时误清除草稿
    if (removed) syncEditorState();
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
  // 如果有正在执行的 run（用户切换画布时生成任务仍在后端运行），先轮询等待完成再加载历史
  useEffect(() => {
    if (!canvasId) return;
    console.log('[ChatPanel] 加载画布历史:', canvasId);

    let cancelled = false;

    // 恢复该画布的未发送草稿（延迟确保 editorRef 已绑定）
    const draftKey = `chat_draft_${canvasId}`;
    const draft = localStorage.getItem(draftKey);
    if (draft) {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const editor = editorRef.current;
        if (editor) {
          editor.innerHTML = draft;
          setHasContent(true);
        }
      });
    }

    (async () => {
      // 加载历史（带重试，防止后端未就绪时首次加载失败）；返回已渲染的条目
      const loadHistoryMessages = async (retries = 2): Promise<ChatEntry[] | null> => {
        for (let i = 0; i <= retries; i++) {
          try {
            const { messages, runs } = await getChatHistory(canvasId);
            if (cancelled) return null;
            console.log('[ChatPanel] 历史加载成功:', messages.length, '条消息 /', runs.length, '条执行记录');
            const loaded = buildHistoryEntries(messages, runs);
            setEntries(loaded);
            return loaded;
          } catch (err) {
            if (cancelled) return null;
            if (i < retries) {
              console.warn(`[ChatPanel] 历史加载失败，${i + 1}s 后重试 (${i + 1}/${retries}):`, err);
              await new Promise(r => setTimeout(r, 1000));
            } else {
              console.warn('[ChatPanel] 历史加载最终失败:', err);
              // 后端未就绪时静默，面板仍可输入
            }
          }
        }
        return null;
      };

      // 先立即渲染已保存的持久化历史，避免切回画布时长时间空白
      const messages = await loadHistoryMessages();
      if (cancelled || !messages) return;

      // 回放后端缓存的流式事件：仅用于"仍在执行中"的 run。
      // 已结束的 run 由历史里的 timeline 持久化完整还原（含中间过程文本与工具卡片），无需回放。
      try {
        const snap = await getStreamSnapshot(canvasId, 0);
        if (cancelled || !snap.events.length || snap.finished) return;

        // 回放期间画布也要同步增量刷新（工具结果里带画布快照）
        for (const evt of snap.events) {
          if ((evt.type === "tool_result" || evt.type === "done") && evt.canvas) {
            onCanvasUpdate(evt.canvas);
          }
        }

        // 进行中：与实时流共用同一套 reduce，从空直播条目归约出尾部条目序列
        const builtTail = snap.events.reduce(reduceStreamEvent, [newLiveAssistant()]);
        setEntries((prev) => [...prev, ...builtTail]);

        // 轮询增量事件，直到后端标记结束，回复自动补全
        let cursor = snap.cursor;
        const deadline = Date.now() + 30 * 60 * 1000;
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          if (cancelled) break;
          let next;
          try {
            next = await getStreamSnapshot(canvasId, cursor);
          } catch {
            continue; // 后端短暂不可用：保留游标，下一轮重试
          }
          if (cancelled) break;
          for (const evt of next.events) {
            if (cancelled) break;
            applyStreamEvent(evt);
          }
          cursor = next.cursor;
          if (next.finished) break;
        }
      } catch (err) {
        console.warn('[ChatPanel] 回放流式事件失败:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
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
    // 清空历史时也清除草稿
    localStorage.removeItem(`chat_draft_${canvasId}`);
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

  // 撤回后把该条输入回填到编辑框：引用标记还原为芯片、换行还原为 <br>，
  // 与原始发送内容一致，用户可直接修改后重新发送
  const restoreEditorContent = (content: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = "";
    for (const seg of parseMessageSegments(content, nodeById)) {
      if (seg.type === "text") {
        appendTextWithBreaks(editor, seg.text);
      } else {
        const node = nodeById.get(seg.ref.id);
        if (node) {
          editor.appendChild(buildRefChip(node));
          editor.appendChild(document.createTextNode(" "));
        } else {
          // 节点已不存在：退化为纯文本标签，避免输入内容丢失
          appendTextWithBreaks(editor, seg.ref.label);
        }
      }
    }
    syncEditorState();
    // 光标落到末尾，方便继续编辑
    editor.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const handleSend = async () => {
    const editor = editorRef.current;
    if (!editor || !canvasId) return;
    // 序列化编辑器：文本原样保留，引用芯片在原位置展开为标记。
    // 同时收集引用图片信息（node_id + image_url），供 Vision 能力使用。
    // 本地气泡与历史持久化共用这份文本，渲染时再解析回芯片
    const { text: message, referencedImages } = serializeEditor(editor);
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    editor.innerHTML = "";
    setHasContent(false);
    // 发送成功后清除该画布的草稿
    localStorage.removeItem(`chat_draft_${canvasId}`);
    // 引用已随消息序列化，清空 App 侧收件箱避免残留
    onClearRefs();
    const ts = Date.now();

    // 标记本轮对话开始（用于整轮撤回）
    const roundId = await beginRound(canvasId);

    // 忙碌（上一轮仍在执行）时本条进入队列：气泡标记"排队中"，
    // 后端在工具边界注入（steering）或下一轮执行时通过 run_start/user_message 事件清除标记。
    // 空闲时立即挂直播条目；忙碌时等待事件创建（保持"段1→用户气泡→段2"的视觉顺序）。
    setEntries((prev) => {
      const busy = prev.some((e) => e.role === "assistant" && e.live);
      const next: ChatEntry[] = [
        ...prev,
        {
          role: "user",
          content: trimmedMessage,
          timestamp: ts,
          roundId: roundId || undefined,
          queued: busy || undefined,
        },
      ];
      if (!busy) {
        next.push({ role: "assistant", content: "", segments: [], timestamp: ts, live: true });
      }
      return next;
    });

    try {
      await chatWithAgentStream(canvasId, trimmedMessage, referencedImages, applyStreamEvent, roundId);
    } catch (e) {
      setEntries((prev) => {
        let idx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === "assistant" && prev[i].live) { idx = i; break; }
        }
        if (idx < 0) {
          return [
            ...prev,
            {
              role: "assistant",
              content: `请求失败：${(e as Error).message}（请检查后端与模型配置）`,
              timestamp: Date.now(),
              error: true,
            },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          content: `请求失败：${(e as Error).message}（请检查后端与模型配置）`,
          error: true,
          live: false,
        };
        return next;
      });
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

  // 人在回路：用户回复 Agent 的询问
  const handleRespond = async (response: string) => {
    if (!canvasId || !response.trim()) return;
    try {
      await respondToAgent(canvasId, response.trim());
      // 更新 UI 标记已回复
      setEntries((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant" || !last.askUser) return prev;
        const next = [...prev];
        next[next.length - 1] = {
          ...last,
          askUser: { ...last.askUser, answered: true, response: response.trim() },
        };
        return next;
      });
    } catch {
      // 回复失败时忽略
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
      ref={panelRef}
      data-role="chat-panel"
      style={{
        position: "fixed",
        top: panelPosition?.y ?? 68,
        left: panelPosition?.x,
        right: panelPosition ? undefined : 16,
        height: "calc(100dvh - 84px)",
        maxHeight: "calc(100dvh - 16px)",
        width,
        maxWidth: "calc(100vw - 16px)",
        background: "rgba(26,26,46,0.97)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(8px)",
        overflow: "hidden",
        // 拖拽期间禁用内容选择，避免拉伸时选中文字
        userSelect: resizing || panelDragging ? "none" : "auto",
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
        onMouseDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button, [data-panel-action]")) return;
          const rect = panelRef.current?.getBoundingClientRect();
          if (!rect) return;
          event.preventDefault();
          panelDragRef.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
          setPanelDragging(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          cursor: panelDragging ? "grabbing" : "grab",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ color: "#ddd", fontSize: 14, fontWeight: 600 }}>
          💬 AI 对话
        </span>
        <div data-panel-action style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {panelPosition && <button type="button" onClick={() => setPanelPosition(null)}
            title="恢复面板默认位置" style={{ background: "none", border: 0, color: "#aaa", cursor: "pointer" }}>复位</button>}
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
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 5,
                // 占满整行：气泡的 maxWidth 百分比才有确定的参照宽度，
                // 否则收缩成极小宽度导致"你好"也被折成两行
                width: "100%",
              }}
              className="chat-user-message"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  maxWidth: "86%",
                  justifyContent: "flex-end",
                }}
              >
                {/* 撤回按钮：悬停时显示，仅当有 roundId 且不是正在发送时可用 */}
                {entry.roundId && !sending && (
                  <button
                    type="button"
                    title="撤回本轮 AI 的所有修改"
                    onClick={async () => {
                      if (!canvasId || !entry.roundId) return;
                      const roundId = entry.roundId;
                      try {
                        const res = await undoRound(canvasId, roundId);
                        // 无论成功失败都刷新画布（后端两种结果都会回传当前画布）
                        onCanvasUpdate(res.canvas);
                        if (res.success) {
                          // 撤回成功：对话面板同步移除该轮及其之后的条目
                          // （后端已截断历史），并把该条输入放回编辑框供重新编辑
                          setEntries((prev) => prev.slice(0, i));
                          restoreEditorContent(entry.content);
                        } else {
                          setEntries((prev) => [
                            ...prev,
                            {
                              role: "assistant",
                              content: `↩️ ${res.message || "这一轮没有可撤回的修改"}`,
                              timestamp: Date.now(),
                              error: true,
                            },
                          ]);
                        }
                      } catch (e) {
                        setEntries((prev) => [
                          ...prev,
                          {
                            role: "assistant",
                            content: `↩️ 撤回失败：${(e as Error).message}`,
                            timestamp: Date.now(),
                            error: true,
                          },
                        ]);
                      }
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(255,255,255,0.4)",
                      cursor: "pointer",
                      padding: "4px",
                      fontSize: 14,
                      opacity: 0,
                      transition: "opacity 0.15s",
                    }}
                    className="chat-undo-btn"
                  >
                    ↩
                  </button>
                )}
                <div
                  style={{
                    maxWidth: "100%",
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
              {/* 已发送但当前回合还在执行：事件到达（注入或新一轮开始）后自动清除 */}
              {entry.queued && (
                <span style={{ color: "#818cf8", fontSize: 11, paddingRight: 4 }}>
                  已发送 · 当前步骤结束后交给 Agent
                </span>
              )}
            </div>
          ) : (
            /* Agent 回复：时间线段按发生顺序渲染（计划/思考/文本/工具自然穿插） */
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entry.segments
                ? entry.segments.map((seg, j) => {
                    if (seg.kind === "plan") {
                      /* 执行计划（规划阶段流式产出，工具执行期间就能看到路线图） */
                      return (
                        <div
                          key={j}
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
                            {seg.text}
                          </ReactMarkdown>
                        </div>
                      );
                    }
                    if (seg.kind === "reasoning") {
                      /* 深度思考过程（实时流式可见；正文开始自动折叠，可点击回看） */
                      return (
                        <div
                          key={j}
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
                                prev.map((e2, j2) => {
                                  if (j2 !== i || !e2.segments) return e2;
                                  const segs = [...e2.segments];
                                  const target = segs[j];
                                  if (target?.kind !== "reasoning") return e2;
                                  segs[j] = { ...target, open: !target.open };
                                  return { ...e2, segments: segs };
                                })
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
                            <span>{seg.open ? "正在思考…" : "已深度思考（点击回看）"}</span>
                            <span style={{ marginLeft: "auto", fontSize: 10 }}>
                              {seg.open ? "▼" : "▶"}
                            </span>
                          </div>
                          {seg.open && (
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
                              {seg.text}
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (seg.kind === "text") {
                      if (!seg.text) return null;
                      return (
                        <div
                          key={j}
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
                            {seg.text}
                          </ReactMarkdown>
                        </div>
                      );
                    }
                    /* 工具调用卡片：按发生顺序穿插在文本流中 */
                    return (
                      <div
                        key={j}
                        style={{
                          alignSelf: "flex-start",
                          maxWidth: "92%",
                          width: "92%",
                          background: "rgba(0,0,0,0.25)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          borderRadius: 8,
                          padding: "6px 10px",
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            background: seg.pending
                              ? "rgba(99,102,241,0.35)"
                              : "rgba(99,102,241,0.2)",
                            color: "#a5b4fc",
                            padding: "1px 8px",
                            borderRadius: 4,
                            fontSize: 11,
                            flexShrink: 0,
                          }}
                        >
                          {TOOL_LABELS[seg.tool || ""] || seg.tool}
                        </span>
                        <span
                          style={{
                            color: seg.pending
                              ? "#818cf8"
                              : seg.success === false
                                ? "#f87171"
                                : "#888",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            animation: seg.pending ? "chatblink 1.2s infinite" : undefined,
                          }}
                          title={seg.result || ""}
                        >
                          {seg.pending ? "执行中..." : seg.result || ""}
                        </span>
                      </div>
                    );
                  })
                : /* 无时间线段的历史/提示消息：纯文本气泡 */
                  entry.content && (
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

              {/* 人在回路：Agent 询问用户 */}
              {entry.askUser && (
                <AskUserCard
                  question={entry.askUser.question}
                  options={entry.askUser.options}
                  timeout={entry.askUser.timeout}
                  default_action={entry.askUser.default_action}
                  startTime={entry.askUser.startTime}
                  answered={entry.askUser.answered}
                  response={entry.askUser.response}
                  onRespond={handleRespond}
                />
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
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {mentionQuery !== null && (
            <div className="mention-menu" role="listbox" aria-label="画布图片引用">
              <div className="mention-menu-header">
                <span>引用画布图片</span>
                <span>{mentionCandidates.length} 张</span>
              </div>
              <div className="mention-menu-list">
                {mentionCandidates.length > 0 ? (
                  mentionCandidates.map((node, index) => (
                    <button
                      key={node.id}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={`mention-option${index === mentionIndex ? " active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMentionNode(node);
                      }}
                      onMouseEnter={() => setMentionIndex(index)}
                    >
                      <img src={node.image_url} alt="" />
                      <span className="mention-option-label">#{node.index}</span>
                      <span className="mention-option-content">
                        {node.content || "画布图片"}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="mention-empty">
                    没有匹配“{mentionQuery ? `#${mentionQuery}` : "画布图片"}”的图片
                  </div>
                )}
              </div>
            </div>
          )}
          <div
            ref={editorRef}
            className="chat-editor"
            contentEditable={!!canvasId}
            suppressContentEditableWarning
            data-placeholder={
              canvasId
                ? sending
                  ? "Agent 执行中，可直接输入并发送"
                  : "输入指令，@ 引用图片，Enter 发送"
                : "画布加载中..."
            }
            onCompositionStart={() => { composingRef.current = true; closeMentionMenu(); }}
            onCompositionEnd={() => { composingRef.current = false; syncEditorState(); updateMentionMenu(); }}
            onInput={() => {
              if (composingRef.current) return;
              syncEditorState();
              updateMentionMenu();
            }}
            onBlur={() => {
              window.setTimeout(() => closeMentionMenu(), 120);
            }}
            onKeyDown={(e) => {
            // 中文输入法组词期间的 Enter 是选词，不触发发送
            if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (mentionQuery !== null) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (mentionCandidates.length > 0) {
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex(
                    (current) =>
                      (current + step + mentionCandidates.length) % mentionCandidates.length
                  );
                }
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                const candidate = mentionCandidates[mentionIndex];
                if (candidate) selectMentionNode(candidate);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeMentionMenu();
                return;
              }
            }
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
            width: "100%",
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
            opacity: !canvasId ? 0.55 : 1,
            }}
          />
        </div>
        {/* 执行中也可发送：消息在当前步骤结束后交给 Agent，按钮始终可用 */}
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
          title={sending ? "Agent 执行中，消息将在当前步骤结束后交给 Agent" : "发送"}
        >
          发送
        </button>
        {sending && (
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
        )}
      </div>

      <style>{`
        @keyframes chatblink {
          0%, 60%, 100% { opacity: 0.25; }
          30% { opacity: 1; }
        }
        @keyframes mentionIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mention-menu {
          position: absolute;
          z-index: 30;
          left: 0;
          right: 0;
          bottom: calc(100% + 7px);
          overflow: hidden;
          border: 1px solid rgba(129,140,248,0.42);
          border-radius: 10px;
          background: rgba(25,25,43,0.98);
          box-shadow: 0 12px 34px rgba(0,0,0,0.42);
          animation: mentionIn 160ms ease-out;
        }
        .mention-menu-header {
          display: flex;
          justify-content: space-between;
          padding: 8px 10px 6px;
          color: #9292aa;
          font-size: 11px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .mention-menu-list {
          max-height: 232px;
          overflow-y: auto;
          padding: 5px;
        }
        .mention-option {
          width: 100%;
          display: grid;
          grid-template-columns: 38px auto minmax(0, 1fr);
          align-items: center;
          gap: 9px;
          min-height: 46px;
          padding: 4px 7px;
          color: #d8d8e6;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
        }
        .mention-option.active {
          background: rgba(99,102,241,0.18);
          border-color: rgba(129,140,248,0.32);
        }
        .mention-option img {
          width: 38px;
          height: 38px;
          object-fit: cover;
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
        }
        .mention-option-label {
          color: #c7d2fe;
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
        }
        .mention-option-content {
          overflow: hidden;
          color: #8f8fa5;
          font-size: 12px;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .mention-empty {
          padding: 18px 10px;
          color: #77778d;
          font-size: 12px;
          text-align: center;
        }
        /* 输入框占位符（contenteditable 无原生 placeholder） */
        .chat-editor:empty::before {
          content: attr(data-placeholder);
          color: #777;
          pointer-events: none;
        }
        /* 用户消息悬停时显示撤回按钮 */
        .chat-user-message:hover .chat-undo-btn {
          opacity: 1 !important;
        }
        .chat-undo-btn:hover {
          color: rgba(255,255,255,0.8) !important;
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
});
