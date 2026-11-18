import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installGlobalErrorReporting } from './utils/logger'

// 可选访问令牌：后端启用 CANVAS_AUTH_TOKEN 时，前端用 VITE_API_TOKEN 同值注入。
// 统一包装 fetch，避免在几十个调用点逐个补请求头（SSE / 日志上报同样生效）。
const apiToken = import.meta.env.VITE_API_TOKEN as string | undefined
if (apiToken) {
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    if (!headers.has('X-Canvas-Token')) headers.set('X-Canvas-Token', apiToken)
    return originalFetch(input, { ...init, headers })
  }
}

// 全局错误捕获（window.onerror / unhandledrejection / 页面离开前 flush）
installGlobalErrorReporting()

// 触屏设备（含 iPad / 华为 MatePad / 外接鼠标）：屏蔽浏览器原生右键与长按菜单，
// 统一交给应用自己的长按/右键菜单；纯鼠标桌面端不受影响。
// 移动浏览器的 maxTouchPoints 偶尔为 0（桌面模式），因此首次触摸时也会补安装。
function enableTouchSuppression() {
  if (document.documentElement.dataset.touchDevice === '1') return
  document.documentElement.dataset.touchDevice = '1'
  // Android / 华为浏览器对 contextmenu 的 preventDefault 支持不一致，
  // 再用 document 属性兜一层（返回 false 等价于阻止默认菜单）
  document.oncontextmenu = () => false
  // Android 长按文字会弹出系统「复制/全选」操作条，它不受 contextmenu 控制，
  // 通过禁止文本选择来屏蔽；输入框/可编辑区例外，否则无法编辑
  document.addEventListener(
    'selectstart',
    (e) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, [contenteditable="true"], [data-allow-select]')) return
      e.preventDefault()
    },
    true
  )
}
if (navigator.maxTouchPoints > 0) enableTouchSuppression()

// 标记真实出现过的输入源：只有触摸/笔真的用过，才启用触屏专属样式（如输入框 16px）。
// 纯鼠标 PC（含带触屏但只用鼠标的笔记本）不会被 @media (pointer: coarse) 误伤。
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      document.documentElement.dataset.input = e.pointerType
      enableTouchSuppression()
    }
  },
  { capture: true, passive: true }
)

window.addEventListener(
  'contextmenu',
  (e) => {
    const ds = document.documentElement.dataset
    if (ds.touchDevice === '1' || ds.input) e.preventDefault()
  },
  { capture: true }
)

// 华为 / 部分 Android 浏览器会忽略 contextmenu 的 preventDefault，直接对图片弹出
// 「查看图片 / 保存图片 / 分享图片」。在 capture 阶段取消图片节点的 touchstart 默认行为，
// 从手势源头终止长按，比拦截 contextmenu 更可靠；拖拽/点选由 pointer 事件负责，不受影响。
document.addEventListener(
  'touchstart',
  (e) => {
    const el = e.target as HTMLElement | null
    if (el?.closest('[data-image-node="1"]')) e.preventDefault()
  },
  { capture: true, passive: false }
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
