import { useEffect, useState, useCallback } from "react";
import { Canvas } from "./components/Canvas";
import { PromptBar } from "./components/PromptBar";
import { HistoryPanel, type HistoryItem } from "./components/HistoryPanel";
import { chatWithAgent, createCanvas, getCanvas, updateNodePosition } from "./api/agent";
import type { CanvasState } from "./types/canvas";

const TOOL_LABELS: Record<string, string> = {
  generate_image: "文生图",
  variate_image: "图生图",
  edit_image: "局部编辑",
  compose_images: "多图组合",
  move_node: "移动节点",
  delete_node: "删除节点",
  list_nodes: "查看节点",
};

function App() {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [statusMsg, setStatusMsg] = useState("");

  // 初始化画布
  useEffect(() => {
    (async () => {
      const id = await createCanvas();
      setCanvasId(id);
      const state = await getCanvas(id);
      setCanvasState(state);
    })();
  }, []);

  const handleSend = useCallback(async (prompt: string) => {
    if (!canvasId) return;
    setLoading(true);
    setStatusMsg("正在思考指令...");

    let currentId = canvasId;

    try {
      const res = await chatWithAgent(currentId, prompt);
      setCanvasState(res.canvas);

      // 从 steps 提取工具信息
      const toolStep = res.steps.find((s: any) => s.type === "tool_call" && s.tool);
      const tool = toolStep?.tool as string | undefined;
      const toolLabel = tool ? TOOL_LABELS[tool] || tool : "";
      setStatusMsg(tool ? `${toolLabel}完成：${res.message}` : res.message);

      setHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random()}`,
          prompt,
          message: res.message,
          tool,
          timestamp: Date.now(),
          success: res.success,
        },
      ]);
    } catch (e) {
      const errMsg = (e as Error).message;
      // 404 = 画布不存在（后端重启），自动重建画布后重试
      if (errMsg.includes("404")) {
        setStatusMsg("画布已过期，正在重建...");
        const newId = await createCanvas();
        setCanvasId(newId);
        const newState = await getCanvas(newId);
        setCanvasState(newState);
        try {
          const res = await chatWithAgent(newId, prompt);
          setCanvasState(res.canvas);
          const toolStep = res.steps.find((s: any) => s.type === "tool_call" && s.tool);
          const tool = toolStep?.tool as string | undefined;
          const toolLabel = tool ? TOOL_LABELS[tool] || tool : "";
          setStatusMsg(tool ? `${toolLabel}完成：${res.message}` : res.message);

          setHistory((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random()}`,
              prompt,
              message: res.message,
              tool,
              timestamp: Date.now(),
              success: res.success,
            },
          ]);
        } catch (e2) {
          setStatusMsg("请求失败：" + (e2 as Error).message);
        }
      } else {
        setStatusMsg("请求失败：" + errMsg);
      }
    } finally {
      setLoading(false);
    }
  }, [canvasId]);

  return (
    <>
      <Canvas
        canvasState={canvasState}
        canvasId={canvasId}
        onNodeMoved={async (nodeId, x, y) => {
          if (!canvasId) return;
          try {
            const newCanvas = await updateNodePosition(canvasId, nodeId, x, y);
            setCanvasState(newCanvas);
          } catch {
            // 静默失败，不影响用户操作
          }
        }}
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
      <PromptBar onSend={handleSend} loading={loading} />

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
