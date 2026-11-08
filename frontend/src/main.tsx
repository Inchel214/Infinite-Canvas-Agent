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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
