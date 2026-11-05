// 快捷键帮助面板（增强版，支持编辑）

import { createPortal } from "react-dom";
import type { ShortcutConfig, ShortcutConflict } from "../types";
import { formatShortcut } from "../state/canvasShortcuts";

interface ShortcutHelpPanelProps {
  bindings: ShortcutConfig;
  conflicts: ShortcutConflict[];
  isRecording: boolean;
  recordingAction: string | null;
  onStartRecording: (action: keyof ShortcutConfig) => void;
  onStopRecording: () => void;
  onReset: () => void;
  onClose: () => void;
}

// 快捷键行组件
function ShortcutRow({ 
  label, 
  shortcut, 
  editable, 
  isRecording,
  conflict,
  onClick 
}: { 
  label: string; 
  shortcut: string; 
  editable?: boolean;
  isRecording?: boolean;
  conflict?: boolean;
  onClick?: () => void;
}) {
  return (
    <div 
      style={{ 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center", 
        padding: "6px 8px",
        borderRadius: 4,
        background: isRecording ? "rgba(167,139,250,0.15)" : "transparent",
        cursor: editable && !isRecording ? "pointer" : "default",
      }}
      onClick={onClick}
      title={editable ? "点击修改快捷键" : undefined}
    >
      <span style={{ color: "#d1d5db", fontSize: 13 }}>{label}</span>
      <kbd style={{
        background: conflict ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.08)",
        border: conflict 
          ? "1px solid rgba(239,68,68,0.4)" 
          : "1px solid rgba(255,255,255,0.15)",
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 11,
        fontFamily: "monospace",
        color: conflict ? "#f87171" : editable ? "#a78bfa" : "#9ca3af",
      }}>
        {isRecording ? "按下按键..." : shortcut}
      </kbd>
    </div>
  );
}

export function ShortcutHelpPanel({
  bindings,
  conflicts,
  isRecording,
  recordingAction,
  onStartRecording,
  onStopRecording,
  onReset,
  onClose,
}: ShortcutHelpPanelProps) {
  // 检查某个 action 是否有冲突
  const getConflict = (action: string): boolean => {
    return conflicts.some((c) => c.actions.includes(action));
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !isRecording) onClose();
      }}
    >
      <div
        style={{
          background: "#1a1a2e",
          borderRadius: 12,
          padding: "24px 32px",
          maxWidth: 520,
          width: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          color: "#e5e7eb",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          scrollbarWidth: "thin",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>快捷键设置</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={onReset}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#9ca3af",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 10px",
              }}
              title="恢复所有快捷键为默认值"
            >
              恢复默认
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "#9ca3af",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "4px 8px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* 录制提示 */}
        {isRecording && (
          <div
            style={{
              background: "rgba(167,139,250,0.15)",
              border: "1px solid rgba(167,139,250,0.4)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontSize: 13, color: "#a78bfa", marginBottom: 2 }}>
                正在录制「{bindings[recordingAction as keyof ShortcutConfig]?.description}」
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                请按下新的快捷键组合
              </div>
            </div>
            <button
              type="button"
              onClick={onStopRecording}
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "none",
                borderRadius: 4,
                color: "#e5e7eb",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 12px",
              }}
            >
              取消
            </button>
          </div>
        )}

        {/* 冲突警告 */}
        {conflicts.length > 0 && (
          <div
            style={{
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.4)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 16,
              fontSize: 12,
              color: "#fca5a5",
            }}
          >
            ⚠️ 快捷键冲突：{conflicts.map((c, i) => (
              <span key={i}>
                {i > 0 && "；"}
                「{c.actions.join("」和「")}」都绑定了 {c.binding}
              </span>
            ))}
          </div>
        )}

        {/* 快捷键列表 - 两列网格布局 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", fontSize: 13 }}>
          <ShortcutRow 
            label="撤销" 
            shortcut={formatShortcut(bindings.undo)} 
            editable={bindings.undo.editable}
            isRecording={isRecording && recordingAction === "undo"}
            conflict={getConflict("undo")}
            onClick={() => bindings.undo.editable && !isRecording && onStartRecording("undo")}
          />
          <ShortcutRow 
            label="重做" 
            shortcut={formatShortcut(bindings.redo)} 
            editable={bindings.redo.editable}
            isRecording={isRecording && recordingAction === "redo"}
            conflict={getConflict("redo")}
            onClick={() => bindings.redo.editable && !isRecording && onStartRecording("redo")}
          />
          <ShortcutRow 
            label="删除选中" 
            shortcut={formatShortcut(bindings.delete)} 
            editable={bindings.delete.editable}
            isRecording={isRecording && recordingAction === "delete"}
            conflict={getConflict("delete")}
            onClick={() => bindings.delete.editable && !isRecording && onStartRecording("delete")}
          />
          <ShortcutRow 
            label="复制图片" 
            shortcut={formatShortcut(bindings.copy)} 
            editable={bindings.copy.editable}
            isRecording={isRecording && recordingAction === "copy"}
            conflict={getConflict("copy")}
            onClick={() => bindings.copy.editable && !isRecording && onStartRecording("copy")}
          />
          <ShortcutRow 
            label="粘贴图片" 
            shortcut={formatShortcut(bindings.paste)} 
            editable={bindings.paste.editable}
            isRecording={isRecording && recordingAction === "paste"}
            conflict={getConflict("paste")}
            onClick={() => bindings.paste.editable && !isRecording && onStartRecording("paste")}
          />
          <ShortcutRow 
            label="全选" 
            shortcut={formatShortcut(bindings.selectAll!)} 
            editable={bindings.selectAll?.editable}
            isRecording={isRecording && recordingAction === "selectAll"}
            conflict={getConflict("selectAll")}
            onClick={() => bindings.selectAll?.editable && !isRecording && onStartRecording("selectAll")}
          />
          <ShortcutRow label="平移画布" shortcut="Space+拖拽 / Shift+拖拽 / 中键拖拽" />
          <ShortcutRow label="缩放" shortcut="滚轮" />
          <ShortcutRow label="框选" shortcut="直接拖拽空白区域" />
          <ShortcutRow label="多选" shortcut="Ctrl+点击 / Shift+点击" />
          <ShortcutRow 
            label="关闭菜单/容器" 
            shortcut={formatShortcut(bindings.escape)} 
            editable={false}
          />
          <ShortcutRow label="粘贴/上传图片" shortcut="直接粘贴到页面" />
        </div>

        {/* 底部提示 */}
        <div style={{ marginTop: 16, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
          点击紫色快捷键可修改 · 按 Esc 关闭面板
        </div>
      </div>
    </div>,
    document.body
  );
}
