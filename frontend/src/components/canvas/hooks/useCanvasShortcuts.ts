// 全局快捷键 Hook：集中管理画布快捷键与局部编辑器快捷键，支持自定义配置

import { useEffect, useState, useCallback } from "react";
import type {
  ShortcutConfig,
  EditorShortcutConfig,
  ShortcutConflict,
  ShortcutScope,
  ShortcutStore,
} from "../types";
import {
  loadShortcutStore,
  saveShortcutStore,
  detectConflicts,
  matchesShortcut,
  resetShortcutStore,
} from "../state/canvasShortcuts";

type Modifiers = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };

export interface UseCanvasShortcutsReturn {
  // 画布分组
  bindings: ShortcutConfig;
  // 局部编辑器分组
  editorBindings: EditorShortcutConfig;
  updateShortcut: (action: keyof ShortcutConfig, key: string, modifiers?: Modifiers) => void;
  updateEditorShortcut: (action: keyof EditorShortcutConfig, key: string, modifiers?: Modifiers) => void;
  resetShortcuts: (scope?: ShortcutScope | "all") => void;
  conflicts: ShortcutConflict[];
  editorConflicts: ShortcutConflict[];
  isRecording: boolean;
  recordingAction: string | null;
  recordingScope: ShortcutScope | null;
  startRecording: (action: keyof ShortcutConfig) => void;
  startEditorRecording: (action: keyof EditorShortcutConfig) => void;
  stopRecording: () => void;
}

export function useCanvasShortcuts(): UseCanvasShortcutsReturn {
  const [store, setStore] = useState<ShortcutStore>(loadShortcutStore);
  const [conflicts, setConflicts] = useState<ShortcutConflict[]>([]);
  const [editorConflicts, setEditorConflicts] = useState<ShortcutConflict[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  const [recordingScope, setRecordingScope] = useState<ShortcutScope | null>(null);

  // 检测两组的冲突
  useEffect(() => {
    setConflicts(detectConflicts(store.canvas, "canvas"));
    setEditorConflicts(detectConflicts(store.editor, "editor"));
  }, [store]);

  const updateShortcut = useCallback(
    (action: keyof ShortcutConfig, key: string, modifiers?: Modifiers) => {
      setStore((prev) => {
        const binding = prev.canvas[action];
        if (!binding || !binding.editable) return prev;
        const next: ShortcutStore = {
          ...prev,
          canvas: { ...prev.canvas, [action]: { ...binding, key, modifiers } } as ShortcutConfig,
        };
        saveShortcutStore(next);
        return next;
      });
    },
    [],
  );

  const updateEditorShortcut = useCallback(
    (action: keyof EditorShortcutConfig, key: string, modifiers?: Modifiers) => {
      setStore((prev) => {
        const binding = prev.editor[action];
        if (!binding || !binding.editable) return prev;
        const next: ShortcutStore = {
          ...prev,
          editor: { ...prev.editor, [action]: { ...binding, key, modifiers } } as EditorShortcutConfig,
        };
        saveShortcutStore(next);
        return next;
      });
    },
    [],
  );

  const resetShortcuts = useCallback((scope: ShortcutScope | "all" = "all") => {
    setStore(resetShortcutStore(scope));
  }, []);

  const startRecording = useCallback(
    (action: keyof ShortcutConfig) => {
      const binding = store.canvas[action];
      if (!binding?.editable) return;
      setIsRecording(true);
      setRecordingAction(action);
      setRecordingScope("canvas");
    },
    [store.canvas],
  );

  const startEditorRecording = useCallback(
    (action: keyof EditorShortcutConfig) => {
      const binding = store.editor[action];
      if (!binding?.editable) return;
      setIsRecording(true);
      setRecordingAction(action);
      setRecordingScope("editor");
    },
    [store.editor],
  );

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setRecordingAction(null);
    setRecordingScope(null);
  }, []);

  // 录制模式键盘监听（独立于画布快捷键，录制时始终可用）
  useEffect(() => {
    if (!isRecording || !recordingAction || !recordingScope) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 只按了修饰键：等待实际按键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // Esc 取消录制（不写入）
      if (e.key === "Escape") {
        stopRecording();
        return;
      }

      // Backspace / Delete 解绑该动作
      if (e.key === "Backspace" || e.key === "Delete") {
        if (recordingScope === "canvas") {
          updateShortcut(recordingAction as keyof ShortcutConfig, "");
        } else {
          updateEditorShortcut(recordingAction as keyof EditorShortcutConfig, "");
        }
        stopRecording();
        return;
      }

      const modifiers: Modifiers = {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: false,
      };

      if (recordingScope === "canvas") {
        updateShortcut(recordingAction as keyof ShortcutConfig, e.key, modifiers);
      } else {
        updateEditorShortcut(recordingAction as keyof EditorShortcutConfig, e.key, modifiers);
      }
      stopRecording();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecording, recordingAction, recordingScope, updateShortcut, updateEditorShortcut, stopRecording]);

  return {
    bindings: store.canvas,
    editorBindings: store.editor,
    updateShortcut,
    updateEditorShortcut,
    resetShortcuts,
    conflicts,
    editorConflicts,
    isRecording,
    recordingAction,
    recordingScope,
    startRecording,
    startEditorRecording,
    stopRecording,
  };
}

// 供需要在不依赖 Hook 的组件里判断按键的场景使用
export { matchesShortcut };
