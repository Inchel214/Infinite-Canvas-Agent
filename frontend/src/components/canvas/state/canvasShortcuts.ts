// 快捷键配置状态管理（localStorage 持久化）

import type { ShortcutConfig, ShortcutConflict, ShortcutBinding } from "../types";
import { DEFAULT_SHORTCUTS, SHORTCUTS_STORAGE_KEY } from "../constants";

// 加载用户自定义快捷键配置（与默认配置合并）
export function loadShortcuts(): ShortcutConfig {
  try {
    const stored = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_SHORTCUTS };
    const parsed = JSON.parse(stored) as Partial<Record<keyof ShortcutConfig, ShortcutBinding>>;
    // 合并用户配置到默认配置（保留不可编辑的快捷键）
    const result = { ...DEFAULT_SHORTCUTS };
    for (const key of Object.keys(parsed) as Array<keyof ShortcutConfig>) {
      if (parsed[key] && result[key]?.editable !== false) {
        result[key] = { ...result[key], ...parsed[key] };
      }
    }
    return result;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

// 保存用户自定义快捷键配置
export function saveShortcuts(config: ShortcutConfig): void {
  try {
    // 只保存可编辑的快捷键
    const toSave: Partial<Record<keyof ShortcutConfig, ShortcutBinding>> = {};
    for (const key of Object.keys(config) as Array<keyof ShortcutConfig>) {
      if (config[key].editable) {
        toSave[key] = config[key];
      }
    }
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // 隐私模式等写入失败时忽略
  }
}

// 将快捷键绑定格式化为可读字符串（如 "Ctrl+Z"），支持备选快捷键（用 / 分隔）
export function formatShortcut(binding: ShortcutBinding): string {
  const formatOne = (key: string, modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }) => {
    const parts: string[] = [];
    if (modifiers?.ctrl) parts.push("Ctrl");
    if (modifiers?.shift) parts.push("Shift");
    if (modifiers?.alt) parts.push("Alt");
    if (modifiers?.meta) parts.push("Meta");
    parts.push(formatKeyName(key));
    return parts.join("+");
  };
  
  const main = formatOne(binding.key, binding.modifiers);
  if (binding.alternatives?.length) {
    const alts = binding.alternatives.map(a => formatOne(a.key, a.modifiers));
    return [main, ...alts].join(" / ");
  }
  return main;
}

// 格式化按键名称（特殊按键友好显示）
function formatKeyName(key: string): string {
  const keyMap: Record<string, string> = {
    Escape: "Esc",
    Delete: "Del",
    Backspace: "Backspace",
    Space: "Space",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return keyMap[key] || key.toUpperCase();
}

// 检测快捷键冲突
export function detectConflicts(config: ShortcutConfig): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  const bindings = Object.entries(config).map(([action, binding]) => ({
    action,
    binding: formatShortcut(binding),
    key: binding.key,
    modifiers: binding.modifiers,
  }));

  // 两两比较检测冲突
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i];
      const b = bindings[j];
      
      // 比较按键和修饰符是否相同
      const sameKey = a.key.toLowerCase() === b.key.toLowerCase();
      const sameModifiers = 
        (a.modifiers?.ctrl ?? false) === (b.modifiers?.ctrl ?? false) &&
        (a.modifiers?.shift ?? false) === (b.modifiers?.shift ?? false) &&
        (a.modifiers?.alt ?? false) === (b.modifiers?.alt ?? false) &&
        (a.modifiers?.meta ?? false) === (b.modifiers?.meta ?? false);
      
      if (sameKey && sameModifiers) {
        conflicts.push({
          actions: [a.action, b.action],
          binding: a.binding,
          severity: "error",
        });
      }
    }
  }
  
  return conflicts;
}

// 检查事件是否匹配快捷键绑定（包括备选快捷键）
export function matchesShortcut(
  e: KeyboardEvent,
  binding: ShortcutBinding
): boolean {
  const matchOne = (key: string, modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }) => {
    // 检查修饰符
    const ctrlMatch = modifiers?.ctrl 
      ? (e.ctrlKey || e.metaKey) 
      : !(e.ctrlKey || e.metaKey);
    const shiftMatch = modifiers?.shift ? e.shiftKey : !e.shiftKey;
    const altMatch = modifiers?.alt ? e.altKey : !e.altKey;
    
    if (!ctrlMatch || !shiftMatch || !altMatch) return false;
    
    // 检查按键
    const eventKey = e.key.toLowerCase();
    const bindingKey = key.toLowerCase();
    
    // 特殊按键处理
    if (bindingKey === "escape" || bindingKey === "esc") {
      return eventKey === "escape";
    }
    if (bindingKey === "space") {
      return e.code === "Space";
    }
    if (bindingKey === "delete") {
      return eventKey === "delete" || eventKey === "backspace";
    }
    
    return eventKey === bindingKey;
  };
  
  // 检查主快捷键
  if (matchOne(binding.key, binding.modifiers)) return true;
  
  // 检查备选快捷键
  if (binding.alternatives?.length) {
    return binding.alternatives.some(alt => matchOne(alt.key, alt.modifiers));
  }
  
  return false;
}

// 恢复默认快捷键配置
export function resetToDefaults(): ShortcutConfig {
  try {
    localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
  } catch {
    // 忽略
  }
  return { ...DEFAULT_SHORTCUTS };
}
