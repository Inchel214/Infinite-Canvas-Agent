// 全局快捷键 Hook：集中管理画布快捷键，支持自定义配置

import { useEffect, useState, useCallback, useRef } from "react";
import type { ShortcutConfig, ShortcutConflict } from "../types";
import {
  loadShortcuts,
  saveShortcuts,
  detectConflicts,
  matchesShortcut,
  resetToDefaults,
} from "../state/canvasShortcuts";

export interface UseCanvasShortcutsOptions {
  enabled?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onEscape?: () => void;
  onSpacePress?: (pressed: boolean) => void;
  onSelectAll?: () => void;
}

export interface UseCanvasShortcutsReturn {
  bindings: ShortcutConfig;
  updateShortcut: (action: keyof ShortcutConfig, key: string, modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }) => void;
  resetShortcuts: () => void;
  conflicts: ShortcutConflict[];
  isRecording: boolean;
  recordingAction: string | null;
  startRecording: (action: keyof ShortcutConfig) => void;
  stopRecording: () => void;
}

export function useCanvasShortcuts(options: UseCanvasShortcutsOptions): UseCanvasShortcutsReturn {
  const {
    enabled = true,
    onUndo,
    onRedo,
    onDelete,
    onCopy,
    onPaste,
    onEscape,
    onSpacePress,
    onSelectAll,
  } = options;

  const [bindings, setBindings] = useState<ShortcutConfig>(loadShortcuts);
  const [conflicts, setConflicts] = useState<ShortcutConflict[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  
  // 用 ref 保存回调，避免 effect 依赖变化
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  // 检测冲突
  useEffect(() => {
    setConflicts(detectConflicts(bindings));
  }, [bindings]);

  // 更新快捷键
  const updateShortcut = useCallback((
    action: keyof ShortcutConfig,
    key: string,
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
  ) => {
    setBindings((prev) => {
      const binding = prev[action];
      if (!binding || !binding.editable) return prev;
      const next = {
        ...prev,
        [action]: { ...binding, key, modifiers },
      };
      saveShortcuts(next);
      return next;
    });
  }, []);

  // 恢复默认
  const resetShortcuts = useCallback(() => {
    const defaults = resetToDefaults();
    setBindings(defaults);
  }, []);

  // 开始录制
  const startRecording = useCallback((action: keyof ShortcutConfig) => {
    const binding = bindings[action];
    if (!binding?.editable) return;
    setIsRecording(true);
    setRecordingAction(action);
  }, [bindings]);

  // 停止录制
  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setRecordingAction(null);
  }, []);

  // 录制模式键盘监听（独立于 enabled，录制时始终可用）
  useEffect(() => {
    if (!isRecording || !recordingAction) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      
      // 如果只按了修饰键，等待实际按键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        return;
      }
      
      const modifiers = {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: false,
      };
      
      updateShortcut(recordingAction as keyof ShortcutConfig, e.key, modifiers);
      stopRecording();
    };

    // 使用 capture 阶段确保优先捕获
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecording, recordingAction, updateShortcut, stopRecording]);

  // 快捷键功能监听（受 enabled 控制）
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 输入框聚焦时不触发快捷键（除了 Esc）
      const target = e.target as HTMLElement;
      const isInputFocused = 
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      
      if (isInputFocused && !matchesShortcut(e, bindings.escape)) {
        return;
      }

      // 检查各个快捷键
      if (matchesShortcut(e, bindings.undo)) {
        e.preventDefault();
        callbacksRef.current.onUndo?.();
        return;
      }
      
      if (matchesShortcut(e, bindings.redo)) {
        e.preventDefault();
        callbacksRef.current.onRedo?.();
        return;
      }
      
      if (matchesShortcut(e, bindings.delete)) {
        e.preventDefault();
        callbacksRef.current.onDelete?.();
        return;
      }
      
      if (matchesShortcut(e, bindings.copy)) {
        e.preventDefault();
        callbacksRef.current.onCopy?.();
        return;
      }
      
      if (matchesShortcut(e, bindings.paste)) {
        e.preventDefault();
        callbacksRef.current.onPaste?.();
        return;
      }
      
      if (matchesShortcut(e, bindings.escape)) {
        // Esc 不 preventDefault，让子组件有机会先处理
        callbacksRef.current.onEscape?.();
        return;
      }
      
      if (bindings.selectAll && matchesShortcut(e, bindings.selectAll)) {
        e.preventDefault();
        callbacksRef.current.onSelectAll?.();
        return;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Space 键释放
      if (matchesShortcut(e, bindings.togglePan)) {
        callbacksRef.current.onSpacePress?.(false);
      }
    };

    // Space 键按下
    const handleSpaceDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, bindings.togglePan)) {
        // 输入框聚焦时不触发平移
        const target = e.target as HTMLElement;
        const isInputFocused = 
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable;
        if (isInputFocused) return;
        
        callbacksRef.current.onSpacePress?.(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleSpaceDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keydown", handleSpaceDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [enabled, bindings]);

  return {
    bindings,
    updateShortcut,
    resetShortcuts,
    conflicts,
    isRecording,
    recordingAction,
    startRecording,
    stopRecording,
  };
}
