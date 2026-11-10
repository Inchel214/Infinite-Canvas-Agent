// 快捷键配置状态管理（localStorage 持久化）
// 画布与局部编辑器共用一份存储，按分组（canvas / editor）保存，避免两套配置割裂

import type {
  ShortcutConfig,
  EditorShortcutConfig,
  ShortcutStore,
  ShortcutConflict,
  ShortcutScope,
  ShortcutBinding,
} from "../types";
import { DEFAULT_SHORTCUTS, DEFAULT_EDITOR_SHORTCUTS, SHORTCUTS_STORAGE_KEY } from "../constants";

type BindingMap = Record<string, ShortcutBinding>;

export function defaultShortcutStore(): ShortcutStore {
  return {
    canvas: { ...DEFAULT_SHORTCUTS },
    editor: { ...DEFAULT_EDITOR_SHORTCUTS },
  };
}

// 把用户配置合并到默认配置：只为「默认存在且可编辑」的键覆盖按键，
// 其余字段（描述、可编辑性等）始终以代码为准，避免旧数据污染新版本
function mergeGroup(defaults: BindingMap, stored: unknown): BindingMap {
  const result: BindingMap = { ...defaults };
  if (!stored || typeof stored !== "object") return result;
  for (const [key, value] of Object.entries(stored as BindingMap)) {
    const def = result[key];
    if (!def || def.editable === false) continue;
    if (!value || typeof value !== "object") continue;
    result[key] = { ...def, key: value.key ?? def.key, modifiers: value.modifiers };
  }
  return result;
}

// 加载配置；兼容旧版「扁平画布配置」的存储格式
export function loadShortcutStore(): ShortcutStore {
  const defaults = defaultShortcutStore();
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const isLegacy = !("canvas" in parsed) && !("editor" in parsed);
    return {
      canvas: mergeGroup(
        defaults.canvas as unknown as BindingMap,
        isLegacy ? parsed : parsed.canvas,
      ) as unknown as ShortcutConfig,
      editor: mergeGroup(
        defaults.editor as unknown as BindingMap,
        isLegacy ? undefined : parsed.editor,
      ) as unknown as EditorShortcutConfig,
    };
  } catch {
    return defaults;
  }
}

// 保存配置：只写可编辑项
export function saveShortcutStore(store: ShortcutStore): void {
  try {
    const pick = (config: BindingMap): BindingMap => {
      const out: BindingMap = {};
      for (const [key, binding] of Object.entries(config)) {
        if (binding.editable) out[key] = binding;
      }
      return out;
    };
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({
        canvas: pick(store.canvas as unknown as BindingMap),
        editor: pick(store.editor as unknown as BindingMap),
      }),
    );
  } catch {
    // 隐私模式等写入失败时忽略
  }
}

// 恢复默认：scope 为 "all" 时两组都重置
export function resetShortcutStore(scope: ShortcutScope | "all" = "all"): ShortcutStore {
  if (scope === "all") {
    try {
      localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
    } catch {
      // 忽略
    }
    return defaultShortcutStore();
  }
  const store = loadShortcutStore();
  if (scope === "canvas") store.canvas = { ...DEFAULT_SHORTCUTS };
  else store.editor = { ...DEFAULT_EDITOR_SHORTCUTS };
  saveShortcutStore(store);
  return store;
}

// 格式化按键名称（特殊按键友好显示）
function formatKeyName(key: string): string {
  const keyMap: Record<string, string> = {
    Escape: "Esc",
    Delete: "Del",
    Backspace: "Backspace",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return keyMap[key] || key.toUpperCase();
}

function formatOne(
  key: string,
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
): string {
  const parts: string[] = [];
  if (modifiers?.ctrl) parts.push("Ctrl");
  if (modifiers?.shift) parts.push("Shift");
  if (modifiers?.alt) parts.push("Alt");
  if (modifiers?.meta) parts.push("Meta");
  parts.push(formatKeyName(key));
  return parts.join("+");
}

// 将快捷键绑定格式化为可读字符串（如 "Ctrl+Z"），支持备选快捷键（用 / 分隔）
export function formatShortcut(binding: ShortcutBinding): string {
  if (!binding.key) return "未设置";
  const main = formatOne(binding.key, binding.modifiers);
  if (binding.alternatives?.length) {
    return [main, ...binding.alternatives.map((a) => formatOne(a.key, a.modifiers))].join(" / ");
  }
  return main;
}

// 生成按键签名，用于冲突检测
function signature(
  key: string,
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
): string {
  const mods = [
    modifiers?.ctrl ? "ctrl" : "",
    modifiers?.shift ? "shift" : "",
    modifiers?.alt ? "alt" : "",
    modifiers?.meta ? "meta" : "",
  ]
    .filter(Boolean)
    .join("+");
  return `${mods}|${key.toLowerCase()}`;
}

// 检测某分组内的快捷键冲突（含备选快捷键，未绑定的动作不参与）
export function detectConflicts(config: unknown, scope: ShortcutScope): ShortcutConflict[] {
  if (!config || typeof config !== "object") return [];
  const entries: Array<{ action: string; sig: string; label: string }> = [];
  for (const [action, binding] of Object.entries(config as BindingMap)) {
    if (!binding || !binding.key) continue;
    entries.push({
      action,
      sig: signature(binding.key, binding.modifiers),
      label: formatOne(binding.key, binding.modifiers),
    });
    binding.alternatives?.forEach((alt) => {
      if (!alt.key) return;
      entries.push({
        action,
        sig: signature(alt.key, alt.modifiers),
        label: formatOne(alt.key, alt.modifiers),
      });
    });
  }

  const conflicts: ShortcutConflict[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.action === b.action || a.sig !== b.sig) continue;
      conflicts.push({
        scope,
        actions: [a.action, b.action],
        binding: a.label,
        severity: "error",
      });
    }
  }
  return conflicts;
}

// 检查事件是否匹配快捷键绑定（包括备选快捷键）；未绑定时恒为 false
export function matchesShortcut(e: KeyboardEvent, binding?: ShortcutBinding): boolean {
  if (!binding || !binding.key) return false;

  const matchOne = (
    key: string,
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ) => {
    const ctrlMatch = modifiers?.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
    const altMatch = modifiers?.alt ? e.altKey : !e.altKey;
    if (!ctrlMatch || !altMatch) return false;
    // "?" 在多数键盘布局需配合 Shift 打出，不能按 shift 修饰符严格匹配
    if (key === "?") return e.key === "?";
    if (!(modifiers?.shift ? e.shiftKey : !e.shiftKey)) return false;

    const eventKey = e.key.toLowerCase();
    const bindingKey = key.toLowerCase();

    if (bindingKey === "escape" || bindingKey === "esc") return eventKey === "escape";
    if (bindingKey === "space") return e.code === "Space";
    if (bindingKey === "delete") return eventKey === "delete" || eventKey === "backspace";

    return eventKey === bindingKey;
  };

  if (matchOne(binding.key, binding.modifiers)) return true;
  if (binding.alternatives?.length) {
    return binding.alternatives.some((alt) => matchOne(alt.key, alt.modifiers));
  }
  return false;
}
