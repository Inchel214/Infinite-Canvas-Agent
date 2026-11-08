// 画布相关常量

import type { ShortcutConfig, EditorShortcutConfig } from "./types";

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
  // 以下为「操作类」动作：默认不绑定按键，由用户按需设置，避免升级时抢占已有键位
  openInpaint: {
    key: "",
    description: "局部编辑（选中单张图片）",
    category: "generation",
    editable: true,
  },
  openEdit: {
    key: "",
    description: "编辑图片（选中单张图片）",
    category: "edit",
    editable: true,
  },
  downloadImage: {
    key: "",
    description: "下载选中图片",
    category: "edit",
    editable: true,
  },
  newCanvas: {
    key: "",
    description: "新建画布",
    category: "view",
    editable: true,
  },
};

// 局部编辑器内默认快捷键
export const DEFAULT_EDITOR_SHORTCUTS: EditorShortcutConfig = {
  brush: {
    key: "b",
    description: "画笔",
    category: "edit",
    editable: true,
  },
  eraser: {
    key: "e",
    description: "橡皮擦",
    category: "edit",
    editable: true,
  },
  lasso: {
    key: "l",
    description: "套索",
    category: "selection",
    editable: true,
  },
  rect: {
    key: "r",
    description: "矩形框选",
    category: "selection",
    editable: true,
  },
  wand: {
    key: "w",
    description: "魔棒",
    category: "selection",
    editable: true,
  },
  invert: {
    key: "i",
    description: "反选",
    category: "selection",
    editable: true,
  },
  brushSmaller: {
    key: "[",
    description: "缩小笔刷",
    category: "edit",
    editable: true,
  },
  brushLarger: {
    key: "]",
    description: "放大笔刷",
    category: "edit",
    editable: true,
  },
  confirm: {
    key: "Enter",
    modifiers: { ctrl: true },
    description: "确认编辑",
    category: "generation",
    editable: true,
  },
  help: {
    key: "?",
    description: "快捷键提示",
    category: "view",
    editable: true,
  },
};
