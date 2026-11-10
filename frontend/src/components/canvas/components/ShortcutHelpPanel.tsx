// 快捷键设置面板：画布 / 局部编辑两组，支持改键、解绑、恢复默认

import { createPortal } from "react-dom";
import type {
  ShortcutConfig,
  EditorShortcutConfig,
  ShortcutConflict,
  ShortcutScope,
  ShortcutBinding,
} from "../types";
import { formatShortcut } from "../state/canvasShortcuts";

interface ShortcutHelpPanelProps {
  bindings: ShortcutConfig;
  editorBindings: EditorShortcutConfig;
  conflicts: ShortcutConflict[];
  editorConflicts: ShortcutConflict[];
  isRecording: boolean;
  recordingAction: string | null;
  recordingScope: ShortcutScope | null;
  onStartRecording: (action: keyof ShortcutConfig) => void;
  onStartEditorRecording: (action: keyof EditorShortcutConfig) => void;
  onStopRecording: () => void;
  onReset: (scope: ShortcutScope | "all") => void;
  onClose: () => void;
}

interface RowSpec {
  action: string;
  label: string;
  binding?: ShortcutBinding;
  scope: ShortcutScope;
}

function ShortcutRow({
  label,
  shortcut,
  editable,
  isRecording,
  conflict,
  onClick,
}: {
  label: string;
  shortcut: string;
  editable?: boolean;
  isRecording?: boolean;
  conflict?: boolean;
  onClick?: () => void;
}) {
  const unset = shortcut === "未设置";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "6px 8px",
        borderRadius: 4,
        background: isRecording ? "rgba(167,139,250,0.15)" : "transparent",
        cursor: editable && !isRecording ? "pointer" : "default",
      }}
      onClick={onClick}
      title={editable ? "点击后按下新按键；Backspace 解绑" : undefined}
    >
      <span style={{ color: "#d1d5db", fontSize: 13 }}>{label}</span>
      <kbd
        style={{
          background: conflict ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.08)",
          border: conflict ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,255,255,0.15)",
          borderRadius: 4,
          padding: "2px 8px",
          fontSize: 11,
          fontFamily: "monospace",
          color: conflict ? "#f87171" : unset ? "#6b7280" : editable ? "#a78bfa" : "#9ca3af",
          whiteSpace: "nowrap",
        }}
      >
        {isRecording ? "按下按键..." : shortcut}
      </kbd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 12,
          color: "#a78bfa",
          fontWeight: 600,
          marginBottom: 6,
          paddingLeft: 2,
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 24px" }}>
        {children}
      </div>
    </div>
  );
}

export function ShortcutHelpPanel({
  bindings,
  editorBindings,
  conflicts,
  editorConflicts,
  isRecording,
  recordingAction,
  recordingScope,
  onStartRecording,
  onStartEditorRecording,
  onStopRecording,
  onReset,
  onClose,
}: ShortcutHelpPanelProps) {
  const getConflict = (list: ShortcutConflict[], action: string) =>
    list.some((c) => c.actions.includes(action));

  const selectedBinding = (() => {
    if (!recordingAction) return undefined;
    if (recordingScope === "canvas") {
      return (bindings as unknown as Record<string, ShortcutBinding>)[recordingAction];
    }
    if (recordingScope === "editor") {
      return (editorBindings as unknown as Record<string, ShortcutBinding>)[recordingAction];
    }
    return undefined;
  })();

  const canvasRows: RowSpec[] = [
    { action: "undo", label: "撤销", binding: bindings.undo, scope: "canvas" },
    { action: "redo", label: "重做", binding: bindings.redo, scope: "canvas" },
    { action: "delete", label: "删除选中", binding: bindings.delete, scope: "canvas" },
    { action: "copy", label: "复制图片", binding: bindings.copy, scope: "canvas" },
    { action: "paste", label: "粘贴图片", binding: bindings.paste, scope: "canvas" },
    { action: "selectAll", label: "全选", binding: bindings.selectAll, scope: "canvas" },
    { action: "openInpaint", label: "局部编辑", binding: bindings.openInpaint, scope: "canvas" },
    { action: "openEdit", label: "编辑图片", binding: bindings.openEdit, scope: "canvas" },
    { action: "downloadImage", label: "下载选中图片", binding: bindings.downloadImage, scope: "canvas" },
    { action: "newCanvas", label: "新建画布", binding: bindings.newCanvas, scope: "canvas" },
    { action: "escape", label: "关闭菜单/容器", binding: bindings.escape, scope: "canvas" },
    { action: "togglePan", label: "平移画布（按住）", binding: bindings.togglePan, scope: "canvas" },
  ];

  const editorRows: RowSpec[] = [
    { action: "brush", label: "画笔", binding: editorBindings.brush, scope: "editor" },
    { action: "eraser", label: "橡皮擦", binding: editorBindings.eraser, scope: "editor" },
    { action: "lasso", label: "套索", binding: editorBindings.lasso, scope: "editor" },
    { action: "rect", label: "矩形框选", binding: editorBindings.rect, scope: "editor" },
    { action: "wand", label: "魔棒", binding: editorBindings.wand, scope: "editor" },
    { action: "invert", label: "反选", binding: editorBindings.invert, scope: "editor" },
    { action: "brushSmaller", label: "缩小笔刷", binding: editorBindings.brushSmaller, scope: "editor" },
    { action: "brushLarger", label: "放大笔刷", binding: editorBindings.brushLarger, scope: "editor" },
    { action: "confirm", label: "确认编辑", binding: editorBindings.confirm, scope: "editor" },
    { action: "help", label: "快捷键提示", binding: editorBindings.help, scope: "editor" },
  ];

  const allConflicts = [...conflicts, ...editorConflicts];

  const renderRow = (row: RowSpec) => {
    const binding = row.binding;
    const editable = binding?.editable ?? false;
    const isRowRecording = isRecording && recordingScope === row.scope && recordingAction === row.action;
    const conflictList = row.scope === "canvas" ? conflicts : editorConflicts;
    return (
      <ShortcutRow
        key={row.action}
        label={row.label}
        shortcut={binding ? formatShortcut(binding) : "未设置"}
        editable={editable}
        isRecording={isRowRecording}
        conflict={getConflict(conflictList, row.action)}
        onClick={() => {
          if (!editable || isRecording) return;
          if (row.scope === "canvas") onStartRecording(row.action as keyof ShortcutConfig);
          else onStartEditorRecording(row.action as keyof EditorShortcutConfig);
        }}
      />
    );
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
    >
      <div
        style={{
          background: "#1a1a2e",
          borderRadius: 12,
          padding: "24px 32px",
          maxWidth: 640,
          width: "92vw",
          maxHeight: "82vh",
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
              onClick={() => onReset("all")}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#9ca3af",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 10px",
              }}
              title="两组快捷键都恢复为默认值"
            >
              全部恢复默认
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
                正在录制「{selectedBinding?.description ?? recordingAction}」
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                按下新的快捷键组合 · Backspace 解绑 · Esc 取消
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
        {allConflicts.length > 0 && (
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
            ⚠️ 快捷键冲突：
            {allConflicts.map((c, i) => (
              <span key={i}>
                {i > 0 && "；"}
                「{c.actions.join("」和「")}」都绑定了 {c.binding}
              </span>
            ))}
          </div>
        )}

        <Section title="画布操作">{canvasRows.map(renderRow)}</Section>

        <Section title="局部编辑（全屏编辑器内）">{editorRows.map(renderRow)}</Section>

        <Section title="鼠标操作（不可修改）">
          <ShortcutRow label="平移画布" shortcut="Shift+拖拽 / 中键拖拽" />
          <ShortcutRow label="缩放画布" shortcut="滚轮" />
          <ShortcutRow label="框选" shortcut="拖拽空白区域" />
          <ShortcutRow label="多选" shortcut="Ctrl+点击 / Shift+点击" />
          <ShortcutRow label="画布内缩放" shortcut="滚轮（以光标为中心）" />
          <ShortcutRow label="画布内平移" shortcut="Space+拖拽" />
        </Section>

        <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280", textAlign: "center" }}>
          点击紫色快捷键可修改 · Backspace 解绑 · Esc 关闭面板
        </div>
      </div>
    </div>,
    document.body,
  );
}
