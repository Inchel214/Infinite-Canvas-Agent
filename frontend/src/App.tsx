import { useEffect, useState, useCallback } from "react";
import { Canvas, type CanvasAction } from "./components/Canvas";
import { HistoryPanel, type HistoryItem } from "./components/HistoryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  createCanvas,
  getCanvas,
  updateNodePosition,
  composeImages,
  variateImage,
  editImage,
  deleteNodes,
  generateImage,
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
  const [history] = useState<HistoryItem[]>([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [providers, setProviders] = useState<Record<string, ProviderPreset>>({});

  // 初始化画布：优先从 localStorage 恢复上次的画布，刷新不丢图
  useEffect(() => {
    (async () => {
      const savedId = localStorage.getItem(LAST_CANVAS_KEY);
      if (savedId) {
        try {
          const state = await getCanvas(savedId);
          setCanvasId(savedId);
          setCanvasState(state);
          return;
        } catch {
          // 画布不存在（后端数据被清理），忽略并新建
          localStorage.removeItem(LAST_CANVAS_KEY);
        }
      }
      const id = await createCanvas();
      localStorage.setItem(LAST_CANVAS_KEY, id);
      setCanvasId(id);
      const state = await getCanvas(id);
      setCanvasState(state);
    })();
  }, []);

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

  // 服务商显示名（徽标用）
  const providerName = (key: string): string =>
    key === "mock" ? "Mock" : providers[key]?.name || key;

  // 右键菜单/图片容器直接操作（不走 Agent），返回是否成功（容器据此决定是否移除自己）
  const handleAction = useCallback(async (action: CanvasAction): Promise<boolean> => {
    if (!canvasId) return false;
    setLoading(true);

    try {
      if (action.type === "compose") {
        setStatusMsg(`正在组合 ${action.nodeIds.length} 张图片...`);
        const res = await composeImages(canvasId, action.nodeIds, action.prompt, action.size, action.x, action.y);
        setCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "variate") {
        setStatusMsg("正在生成变体...");
        const res = await variateImage(canvasId, action.nodeId, action.prompt, action.size, action.x, action.y);
        setCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "edit") {
        setStatusMsg("正在编辑图片...");
        const res = await editImage(canvasId, action.nodeId, action.prompt, action.size);
        setCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "generate") {
        setStatusMsg("正在生成图片...");
        const res = await generateImage(canvasId, action.prompt, action.size, action.x, action.y);
        setCanvasState(res.canvas);
        setStatusMsg(res.message);
        return res.success;
      } else if (action.type === "delete") {
        setStatusMsg("正在删除...");
        const res = await deleteNodes(canvasId, action.nodeIds);
        setCanvasState(res.canvas);
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
  }, [canvasId]);

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
        canvasState={canvasState}
        canvasId={canvasId}
        busy={loading}
        onNodeMoved={async (nodeId, x, y) => {
          if (!canvasId) return;
          try {
            const newCanvas = await updateNodePosition(canvasId, nodeId, x, y);
            setCanvasState(newCanvas);
          } catch {
            // 静默失败，不影响用户操作
          }
        }}
        onAction={handleAction}
        onCanvasUpdate={setCanvasState}
      />

      {/* 大模型设置入口 + 当前模式徽标 */}
      <div
        onClick={() => setShowSettings(true)}
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 1000,
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

      {/* 设置面板 */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}

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

      <HistoryPanel items={history} />
      {/* 底部指令栏暂时隐藏 */}
      {/* <PromptBar onSend={handleSend} loading={loading} /> */}

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
