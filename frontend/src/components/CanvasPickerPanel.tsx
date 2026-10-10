// 画布管理面板：列出 / 切换 / 新建 / 重命名 / 删除画布

import { useCallback, useEffect, useRef, useState } from "react";
import { listCanvases, renameCanvas, deleteCanvas } from "../api/agent";
import type { CanvasSummary } from "../types/canvas";

interface CanvasPickerPanelProps {
  currentCanvasId: string | null;
  // 各画布生图任务状态（红点）：canvas_id -> { generating, pending }，App 轮询维护
  badges: Record<string, { generating: number; pending: number }>;
  onClose: () => void;
  // 切换到指定画布，返回是否成功
  onSwitch: (id: string) => Promise<boolean>;
  // 新建画布并切换，返回新画布 id（失败 null）
  onCreate: () => Promise<string | null>;
  // 操作反馈（走 App 的 statusMsg 机制，2.2s 自动淡出）
  onStatus: (msg: string) => void;
}

// 相对时间：3 分钟前 / 2 小时前 / 昨天 / 3 天前
function relTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 2) return "昨天";
  return `${Math.floor(diff / 86400)} 天前`;
}

export function CanvasPickerPanel({
  currentCanvasId,
  badges,
  onClose,
  onSwitch,
  onCreate,
  onStatus,
}: CanvasPickerPanelProps) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // 正在重命名的画布 id + 输入值
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // 删除二步确认：第一次点 🗑 变成确认按钮，3 秒未确认自动还原
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<CanvasSummary[]> => {
    const list = await listCanvases();
    setCanvases(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        // 后端未启动时面板显示空列表
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  // 卸载时清理确认计时器
  useEffect(() => {
    return () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const startRename = (c: CanvasSummary) => {
    setRenamingId(c.canvas_id);
    setRenameValue(c.name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (!name || name.length > 50) {
      onStatus(name ? "名称不能超过 50 字" : "名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await renameCanvas(renamingId, name);
      setRenamingId(null);
      onStatus("已重命名");
      await refresh();
    } catch (e) {
      onStatus("重命名失败：" + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleClickDelete = (id: string) => {
    if (confirmDeleteId !== id) {
      // 第一次点：进入确认态，3 秒未确认自动还原
      setConfirmDeleteId(id);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(
        () => setConfirmDeleteId(null),
        3000
      );
      return;
    }
    // 第二次点：真正删除
    void handleDelete(id);
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteCanvas(id);
      onStatus("已删除画布");
      const list = await refresh();
      // 删的是当前画布 → 切到列表第一份；没有别的画布则新建
      if (id === currentCanvasId) {
        const next = list.find((c) => c.canvas_id !== id);
        if (next) {
          await onSwitch(next.canvas_id);
        } else {
          await onCreate();
        }
      }
    } catch (e) {
      onStatus("删除失败：" + (e as Error).message);
    } finally {
      setBusy(false);
      setConfirmDeleteId(null);
    }
  };

  const handleSwitch = async (id: string) => {
    if (busy || id === currentCanvasId) return;
    setBusy(true);
    try {
      const ok = await onSwitch(id);
      if (ok) {
        onStatus("已切换画布");
        onClose();
      } else {
        onStatus("画布不存在，已刷新列表");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await onCreate();
      if (id) {
        onStatus("已新建画布");
        onClose();
      } else {
        onStatus("新建失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "92vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "rgba(26,26,46,0.98)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "18px 20px 16px",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      >
        {/* 标题 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>
            🗂 画布管理
          </span>
          <span
            onClick={onClose}
            style={{ color: "#888", fontSize: 13, cursor: "pointer" }}
          >
            ✕
          </span>
        </div>
        <div style={{ color: "#777", fontSize: 12, marginBottom: 12 }}>
          点击画布切换；✏️ 重命名、🗑 删除
        </div>

        {/* 列表 */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minHeight: 60,
          }}
        >
          {loading && <div style={{ color: "#888", fontSize: 13 }}>加载中...</div>}
          {!loading && canvases.length === 0 && (
            <div style={{ color: "#888", fontSize: 13 }}>还没有画布</div>
          )}
          {canvases.map((c) => {
            const isCurrent = c.canvas_id === currentCanvasId;
            const isRenaming = renamingId === c.canvas_id;
            const isConfirming = confirmDeleteId === c.canvas_id;
            const badge = badges[c.canvas_id] || { generating: 0, pending: 0 };
            return (
              <div
                key={c.canvas_id}
                onClick={() => !isRenaming && handleSwitch(c.canvas_id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderRadius: 8,
                  cursor: isRenaming ? "default" : "pointer",
                  background: isCurrent
                    ? "rgba(99,102,241,0.18)"
                    : "rgba(255,255,255,0.04)",
                  border: isCurrent
                    ? "1px solid rgba(99,102,241,0.6)"
                    : "1px solid transparent",
                  opacity: busy && !isCurrent ? 0.55 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      disabled={busy}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        background: "rgba(255,255,255,0.08)",
                        border: "1px solid rgba(99,102,241,0.6)",
                        borderRadius: 6,
                        color: "#eee",
                        fontSize: 13,
                        padding: "5px 8px",
                        outline: "none",
                      }}
                    />
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: 13,
                          color: isCurrent ? "#c7d2fe" : "#ddd",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.name}
                        </span>
                        {isCurrent && (
                          <span style={{ color: "#818cf8", fontSize: 11 }}>当前</span>
                        )}
                        {badge.pending > 0 && (
                          <span
                            title={`${badge.pending} 张新生成的图片待查看`}
                            style={{
                              flexShrink: 0,
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
                            }}
                          >
                            {badge.pending > 99 ? "99+" : badge.pending}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>
                        {c.node_count} 张图 · {relTime(c.updated_at)}
                        {badge.generating > 0 && (
                          <span style={{ color: "#a5b4fc", marginLeft: 6 }}>
                            · 生成中 {badge.generating} 张…
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {isRenaming ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      void commitRename();
                    }}
                    style={{
                      fontSize: 12,
                      color: "#4ade80",
                      cursor: busy ? "wait" : "pointer",
                      userSelect: "none",
                    }}
                  >
                    ✓ 保存
                  </span>
                ) : (
                  <>
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                      style={{
                        fontSize: 13,
                        color: "#888",
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                      title="重命名"
                    >
                      ✏️
                    </span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClickDelete(c.canvas_id);
                      }}
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 6,
                        color: isConfirming ? "#fff" : "#888",
                        background: isConfirming ? "rgba(220,38,38,0.8)" : "transparent",
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                      title={isConfirming ? "再点一次确认删除" : "删除"}
                    >
                      {isConfirming ? "确认？" : "🗑"}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* 新建按钮 */}
        <button
          onClick={handleCreate}
          disabled={busy}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "9px 0",
            borderRadius: 8,
            border: "none",
            background: "rgba(99,102,241,0.85)",
            color: "#fff",
            fontSize: 13,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          ＋ 新建画布
        </button>
      </div>
    </div>
  );
}
