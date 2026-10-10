import { useEffect, useState, useCallback, useRef } from "react";
import { Canvas, type CanvasAction } from "./components/Canvas";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { CanvasPickerPanel } from "./components/CanvasPickerPanel";
import {
  createCanvas,
  getCanvas,
  updateNodePosition,
  composeImages,
  variateImage,
  editImage,
  deleteNodes,
  generateImage,
  arrangeCanvas,
  listCanvases,
  markCanvasSeen,
  getSettings,
  getProviders,
  type AppSettingsData,
  type ProviderPreset,
} from "./api/agent";
import type { CanvasState } from "./types/canvas";

const LAST_CANVAS_KEY = "ica:lastCanvasId";

function App() {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [providers, setProviders] = useState<Record<string, ProviderPreset>>({});
  // 各画布生图任务状态（红点）：canvas_id -> { generating, pending }
  const [badges, setBadges] = useState<Record<string, { generating: number; pending: number }>>({});
  // 守卫用：异步回调校验画布身份时读最新值（不经 React state 闭包）
  const canvasIdRef = useRef<string | null>(null);

  // 应用画布身份：同步 state / ref / localStorage / URL（多标签直达 + 刷新恢复）
  const applyCanvasId = useCallback((id: string, state?: CanvasState) => {
    canvasIdRef.current = id;
    setCanvasId(id);
    localStorage.setItem(LAST_CANVAS_KEY, id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("canvas", id);
      window.history.replaceState(null, "", url);
    } catch {
      // URL 操作失败不影响画布加载
    }
    if (state) setCanvasState(state);
  }, []);

  // 状态守卫：旧画布上残留的异步回调（SSE 生成完成、粘贴完成等）带着旧画布状态 resolve
  // 时，若已切换画布则丢弃，防止旧数据覆盖新画布
  const applyCanvasState = useCallback((next: CanvasState) => {
    if (canvasIdRef.current && next.canvas_id !== canvasIdRef.current) return;
    setCanvasState(next);
  }, []);

  // 切换到指定画布（画布管理面板调用），返回是否成功；切换 = 打开会话，清除该画布未读红点
  const switchCanvas = useCallback(async (id: string): Promise<boolean> => {
    try {
      const state = await getCanvas(id);
      applyCanvasId(id, state);
      markCanvasSeen(id);
      setBadges((prev) => ({ ...prev, [id]: { generating: prev[id]?.generating ?? 0, pending: 0 } }));
      return true;
    } catch {
      return false;
    }
  }, [applyCanvasId]);

  // 新建画布并切换过去，返回新画布 id（失败 null）
  const createNewCanvas = useCallback(async (): Promise<string | null> => {
    try {
      const id = await createCanvas();
      const state = await getCanvas(id);
      applyCanvasId(id, state);
      return id;
    } catch {
      return null;
    }
  }, [applyCanvasId]);

  // 初始化画布：URL ?canvas=xx 直达 > 上次打开的画布 > 新建
  useEffect(() => {
    (async () => {
      const urlId = new URLSearchParams(window.location.search).get("canvas");
      if (urlId) {
        try {
          const state = await getCanvas(urlId);
          applyCanvasId(urlId, state);
          return;
        } catch {
          // 后端已删该画布，回退到 localStorage
        }
      }
      const savedId = localStorage.getItem(LAST_CANVAS_KEY);
      if (savedId) {
        try {
          const state = await getCanvas(savedId);
          applyCanvasId(savedId, state);
          return;
        } catch {
          // 画布不存在（后端数据被清理），忽略并新建
          localStorage.removeItem(LAST_CANVAS_KEY);
        }
      }
      const id = await createCanvas();
      const state = await getCanvas(id);
      applyCanvasId(id, state);
    })();
  }, [applyCanvasId]);

  // 加载大模型配置（供顶栏徽标显示）
  useEffect(() => {
    (async () => {
      try {
        const [s, p] = await Promise.all([getSettings(), getProviders()]);
        setSettings(s);
        setProviders(p.providers);
      } catch {
        // 后端未启动时静默失败，徽标显示默认文案
      }
    })();
  }, []);

  // 红点轮询：定期拉取各画布生图状态（生成中/未读新图）。
  // 当前画布的 pending 静默清除（用户正看着，不产生"未读"）
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await listCanvases();
        if (cancelled) return;
        const next: Record<string, { generating: number; pending: number }> = {};
        for (const c of list) {
          next[c.canvas_id] = { generating: c.generating ?? 0, pending: c.pending ?? 0 };
        }
        // 当前画布的未读静默清掉（用户就在这个画布上），本地同步置零避免红点闪烁
        const currentId = canvasIdRef.current;
        if (currentId && next[currentId]) {
          if (next[currentId].pending > 0) markCanvasSeen(currentId);
          next[currentId] = { ...next[currentId], pending: 0 };
        }
        setBadges(next);
      } catch {
        // 后端未启动时静默失败，下轮重试
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 顶栏红点总数：未查看的新图（生成中不算未读，只算状态提示）
  const totalPending = Object.values(badges).reduce((s, b) => s + b.pending, 0);

  // 服务商显示名（徽标用）
  const providerName = (key: string): string =>
    key === "mock" ? "Mock" : providers[key]?.name || key;

  // 右键菜单/图片容器直接操作（不走 Agent），返回是否成功（容器据此决定是否移除自己）
  const handleAction = useCallback(async (action: CanvasAction): Promise<boolean> => {
    if (!canvasId) return false;
    setLoading(true);

    try {
      if (action.type === "compose") {
        // 进行中状态显示在被操作图片的边界框上（Canvas processing），顶部不再提示
        const res = await composeImages(canvasId, action.nodeIds, action.prompt, action.size, action.x, action.y);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "variate") {
        const res = await variateImage(canvasId, action.nodeId, action.prompt, action.size, action.x, action.y);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "edit") {
        const res = await editImage(canvasId, action.nodeId, action.prompt, action.size, action.x, action.y);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "generate") {
        setStatusMsg("正在生成图片...");
        const res = await generateImage(canvasId, action.prompt, action.size, action.x, action.y);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "delete") {
        setStatusMsg("正在删除...");
        const res = await deleteNodes(canvasId, action.nodeIds);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "arrange") {
        setStatusMsg("正在整理画布...");
        const res = await arrangeCanvas(canvasId);
        applyCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      }
      return false;
    } catch (e) {
      setStatusMsg("操作失败：" + (e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [canvasId, applyCanvasState]);

  // 操作完成后，提示自动淡出（非常驻显示）
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!statusMsg || loading) return;
    setFading(false);
    const t1 = setTimeout(() => setFading(true), 1700);
    const t2 = setTimeout(() => { setStatusMsg(""); setFading(false); }, 2200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [statusMsg, loading]);

  return (
    <>
      <Canvas
        key={canvasId ?? "none"}
        canvasState={canvasState}
        canvasId={canvasId}
        busy={loading}
        onNodeMoved={async (nodeId, x, y) => {
          if (!canvasId) return;
          try {
            const newCanvas = await updateNodePosition(canvasId, nodeId, x, y);
            applyCanvasState(newCanvas);
          } catch {
            // 静默失败，不影响用户操作
          }
        }}
        onAction={handleAction}
        onCanvasUpdate={applyCanvasState}
      />

      {/* 右上角入口：画布管理 + 大模型设置 */}
      <div
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {/* 画布管理入口（显示当前画布名） */}
        <div
          onClick={() => setShowPicker(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(26,26,46,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "8px 14px",
            cursor: "pointer",
            color: "#ccc",
            fontSize: 13,
            userSelect: "none",
            backdropFilter: "blur(8px)",
            maxWidth: 220,
          }}
          title="切换 / 新建 / 管理画布"
        >
          <span style={{ fontSize: 15, position: "relative" }}>
            🗂
            {totalPending > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -8,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: "#e5484d",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: "16px",
                  textAlign: "center",
                  boxShadow: "0 0 4px rgba(229,72,77,0.6)",
                }}
              >
                {totalPending > 99 ? "99+" : totalPending}
              </span>
            )}
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {canvasState?.name || "画布"}
          </span>
        </div>

        {/* 大模型设置入口 + 当前模式徽标 */}
        <div
          onClick={() => setShowSettings(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(26,26,46,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "8px 14px",
            cursor: "pointer",
            color: "#ccc",
            fontSize: 13,
            userSelect: "none",
            backdropFilter: "blur(8px)",
          }}
          title="点击设置大模型服务商与 API Key"
        >
        <span style={{ fontSize: 15 }}>⚙</span>
        {settings ? (
          <span>
            图片 {providerName(settings.status.image.provider)}
            <span style={{ color: "#555", margin: "0 4px" }}>|</span>
            对话 {providerName(settings.status.llm.provider)}
          </span>
        ) : (
          <span>设置</span>
        )}
        {settings && settings.status.image.mode === "mock" && (
          <span
            style={{
              background: "rgba(217,119,6,0.25)",
              color: "#fbbf24",
              padding: "1px 8px",
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            未配置
          </span>
        )}
        </div>
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}

      {/* 画布管理面板 */}
      {showPicker && (
        <CanvasPickerPanel
          currentCanvasId={canvasId}
          badges={badges}
          onClose={() => setShowPicker(false)}
          onSwitch={switchCanvas}
          onCreate={createNewCanvas}
          onStatus={setStatusMsg}
        />
      )}

      {/* AI 对话面板（按画布 key 重挂载，切换画布自动换对应历史） */}
      <ChatPanel
        key={`chat-${canvasId ?? "none"}`}
        canvasId={canvasId}
        onCanvasUpdate={applyCanvasState}
      />

      {/* 执行状态提示 */}
      {statusMsg && (
        <div
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: loading ? "rgba(99,102,241,0.9)" : "rgba(34,34,51,0.95)",
            color: "white",
            padding: "8px 16px",
            borderRadius: 8,
            fontSize: 13,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            gap: 8,
            maxWidth: "70vw",
            opacity: fading ? 0 : 1,
            transition: "opacity 0.5s ease",
          }}
        >
          {loading && (
            <span
              style={{
                width: 12,
                height: 12,
                border: "2px solid rgba(255,255,255,0.3)",
                borderTopColor: "#fff",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                display: "inline-block",
              }}
            />
          )}
          {statusMsg}
        </div>
      )}

      {/* spinner 动画 */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

export default App;
