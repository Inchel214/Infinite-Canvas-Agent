// 画布相关类型定义

import type { CanvasState, CanvasNode } from "../../types/canvas";

// 右键菜单可触发的操作类型（experienceIds：风格库多选的风格，直连生图时后端确定性拼接）
export type CanvasAction =
  | { type: "text"; content: string; x: number; y: number }
  | { type: "compose"; nodeIds: string[]; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[] }
  | { type: "variate"; nodeId: string; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[] }
  | { type: "edit"; nodeId: string; prompt: string; size: string; x?: number; y?: number; experienceIds?: string[]; mask?: string }
  | { type: "generate"; prompt: string; size: string; x: number; y: number; experienceIds?: string[] }
  | { type: "delete"; nodeIds: string[] }
  | { type: "arrange" }
  | { type: "update"; updates: Array<{ nodeId: string; content?: string; x?: number; y?: number; width?: number; height?: number }> };

// 待生成图片容器（右键空白创建，接收连线作为参考图）
export type PendingContainer = {
  id: string;
  x: number;            // 世界坐标锚点（左上角）
  y: number;
  w: number;            // 编辑态屏幕像素宽；生成后作为画布世界尺寸随视角缩放
  h: number;            // 编辑态屏幕像素高；生成后作为画布世界尺寸随视角缩放
  aspect: string;
  resolution: string;
  count?: number;
  prompt: string;
  refIds: string[];     // 连线进来的参考图节点 ID
  experienceIds?: string[]; // 风格库多选的风格
  error?: string;       // 生成失败提示
  previewUrl?: string;  // 流式生成的中间预览图
  exiting?: boolean;    // 生成完成后正在退场（淡出中）
};

// 矩形（节点或容器）的边界框
export type BBox = { x: number; y: number; width: number; height: number };

// 右键菜单状态
export type MenuState = {
  x: number;
  y: number;
  mode: "menu" | "compose" | "variate" | "background";
};

// 编辑图片框状态：独立于右键菜单，可与之并存
export type EditPanelState = {
  refIds: string[];  // 图1固定为被编辑底图，其余为附加参考图
  x: number;         // 屏幕坐标（fixed 定位）
  y: number;
  prompt: string;
  aspect: string;
  resolution: string;
  experienceIds?: string[]; // 风格库多选的风格
};

// Canvas 组件 Props
export interface CanvasProps {
  canvasState: CanvasState | null;
  canvasId: string | null;
  busy?: boolean;
  onNodeMoved?: (nodeId: string, x: number, y: number) => boolean | void | Promise<boolean | void>;
  // 多选整组拖拽结束：一次性提交所有节点的新位置（后端单次保存 = 单次撤销）
  onNodesMoved?: (moves: { nodeId: string; x: number; y: number }[]) => boolean | void | Promise<boolean | void>;
  onAction?: (action: CanvasAction) => boolean | void | Promise<boolean | void>;
  onCanvasUpdate?: (state: CanvasState, restoreHistory?: boolean) => void;
  // 右键"添加到对话"：把选中图片引用进 ChatPanel，发送时注入 Agent 上下文
  onAddToChat?: (nodeIds: string[]) => void;
  // 右侧对话面板展开时占据的宽度（含定位边距前的面板净宽）；用于缩放指示器避让
  chatDockWidth?: number;
}

// 快捷键绑定
export interface ShortcutBinding {
  key: string;           // 如 "z", "y", "delete"；空字符串表示未绑定
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  description: string;   // 用户可读描述
  category: "view" | "edit" | "selection" | "generation";
  editable: boolean;     // 是否允许用户修改
  alternatives?: Array<{ key: string; modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } }>; // 备选快捷键（如重做的 Ctrl+Shift+Z）
}

// 画布快捷键配置
export interface ShortcutConfig {
  undo: ShortcutBinding;
  redo: ShortcutBinding;
  delete: ShortcutBinding;
  copy: ShortcutBinding;
  paste: ShortcutBinding;
  escape: ShortcutBinding;
  togglePan: ShortcutBinding;
  selectAll?: ShortcutBinding;
  openInpaint: ShortcutBinding;   // 局部编辑（默认不绑定）
  openEdit: ShortcutBinding;      // 编辑图片（默认不绑定）
  downloadImage: ShortcutBinding; // 下载选中图片（默认不绑定）
  newCanvas: ShortcutBinding;     // 新建画布（默认不绑定）
}

// 局部编辑器内快捷键配置
export interface EditorShortcutConfig {
  brush: ShortcutBinding;
  eraser: ShortcutBinding;
  lasso: ShortcutBinding;
  rect: ShortcutBinding;
  wand: ShortcutBinding;
  invert: ShortcutBinding;
  brushSmaller: ShortcutBinding;
  brushLarger: ShortcutBinding;
  confirm: ShortcutBinding;
  help: ShortcutBinding;
}

// 快捷键设置分组
export type ShortcutScope = "canvas" | "editor";

// 完整快捷键配置（画布 + 局部编辑器统一存储）
export interface ShortcutStore {
  canvas: ShortcutConfig;
  editor: EditorShortcutConfig;
}

// 快捷键冲突信息
export interface ShortcutConflict {
  scope: ShortcutScope;
  actions: string[];     // 冲突的动作名
  binding: string;       // 冲突的按键
  severity: "error" | "warning";
}

// 重新导出外部类型供其他模块使用
export type { CanvasState, CanvasNode };
