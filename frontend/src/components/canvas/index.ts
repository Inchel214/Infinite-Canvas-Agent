// Canvas 模块入口：保持原有导入路径兼容
// 重构后的组件将从 canvas/ 目录导入，但外部仍可通过原路径导入

// 类型导出
export type {
  CanvasAction,
  PendingContainer,
  BBox,
  MenuState,
  EditPanelState,
  CanvasProps,
  ShortcutBinding,
  ShortcutConfig,
  ShortcutConflict,
} from "./types";

// 常量导出
export {
  ASPECT_RATIOS,
  RESOLUTIONS,
  CONTAINER_BASE_W,
  CONTAINER_BASE_H,
  DEFAULT_SHORTCUTS,
} from "./constants";

// Hook 导出
export { useCanvasShortcuts } from "./hooks/useCanvasShortcuts";

// 组件导出（待后续迁移完成后添加）
// export { Canvas } from "./components/Canvas";
