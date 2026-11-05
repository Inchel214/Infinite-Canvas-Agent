// 画布相关常量

import type { ShortcutConfig } from "./types";

// 宽高比预设（长边 = 分辨率档位）
export const ASPECT_RATIOS = [
  { key: "1:1", w: 1, h: 1 },
  { key: "4:3", w: 4, h: 3 },
  { key: "3:4", w: 3, h: 4 },
  { key: "16:9", w: 16, h: 9 },
  { key: "9:16", w: 9, h: 16 },
  { key: "3:2", w: 3, h: 2 },
  { key: "2:3", w: 2, h: 3 },
  { key: "21:9", w: 21, h: 9 },
] as const;

export const RESOLUTIONS = ["1K", "2K", "4K"] as const;

// 风格库使用统计 localStorage key
export const EXPERIENCE_USAGE_KEY = "ica:experienceUsage";
export const EXPERIENCE_USAGE_EVENT = "ica:experienceUsageChanged";

// @图片 提及正则
export const IMAGE_MENTION_RE = /@图片(\d+)/g;

// 容器面板基准尺寸：编辑态按屏幕像素渲染以保证可读；开始生成后同一数值
// 转为画布世界尺寸，使整张卡片随相机 zoom 自然退远。
export const CONTAINER_BASE_W = 320; // 与右侧编辑面板接近的紧凑宽度，比例按钮仍保持一行
export const CONTAINER_BASE_H = 480; // 紧凑字号体系下的自然高度；基准须覆盖内容高度，避免拉伸柄错位

// 快捷键配置 localStorage key
export const SHORTCUTS_STORAGE_KEY = "ica:shortcuts";

// 默认快捷键配置
export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  undo: {
    key: "z",
    modifiers: { ctrl: true },
    description: "撤销",
    category: "edit",
    editable: true,
  },
  redo: {
    key: "y",
    modifiers: { ctrl: true },
    description: "重做",
    category: "edit",
    editable: true,
    alternatives: [{ key: "z", modifiers: { ctrl: true, shift: true } }], // Ctrl+Shift+Z
  },
  delete: {
    key: "Delete",
    description: "删除选中",
    category: "edit",
    editable: true,
  },
  copy: {
    key: "c",
    modifiers: { ctrl: true },
    description: "复制图片",
    category: "edit",
    editable: true,
  },
  paste: {
    key: "v",
    modifiers: { ctrl: true },
    description: "粘贴图片",
    category: "edit",
    editable: true,
  },
  escape: {
    key: "Escape",
    description: "关闭菜单/容器",
    category: "view",
    editable: false, // Esc 不可修改
  },
  togglePan: {
    key: "Space",
    description: "平移画布（按住）",
    category: "view",
    editable: false, // Space 不可修改
  },
  selectAll: {
    key: "a",
    modifiers: { ctrl: true },
    description: "全选",
    category: "selection",
    editable: true,
  },
};
