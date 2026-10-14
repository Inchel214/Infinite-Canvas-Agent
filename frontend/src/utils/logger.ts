// 前端日志上报：把运行时错误/关键日志批量发送到后端 /api/client_logs
// 机制：内存队列缓冲 → 定时 / 页面隐藏时经 sendBeacon（fetch keepalive 兜底）批量上报。
// 上报失败静默丢弃（错误处理路径里绝不能再抛错，避免递归）；后端与自身日志合流写入 backend/data/logs/app.log。

const API_BASE = "http://127.0.0.1:8000/api";

type Level = "info" | "warn" | "error";

interface QueuedLog {
  level: Level;
  message: string;
  stack?: string;
  ts: number;
}

const queue: QueuedLog[] = [];
const MAX_QUEUE = 50; // 队列上限，超出丢最旧（防内存膨胀）
const FLUSH_MS = 5000; // 定时上报间隔
const MAX_MSG = 2000;
const MAX_STACK = 4000;

let installed = false;

// 当前画布 id 随上报携带，便于把错误关联到具体画布
function currentCanvasId(): string | undefined {
  try {
    return localStorage.getItem("ica:lastCanvasId") ?? undefined;
  } catch {
    return undefined;
  }
}

export function reportLog(level: Level, message: unknown, stack?: string): void {
  try {
    queue.push({
      level,
      message: String(message).slice(0, MAX_MSG),
      stack: stack?.slice(0, MAX_STACK),
      ts: Date.now(),
    });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  } catch {
    /* 队列操作失败（理论不会发生）静默 */
  }
}

export function reportError(message: unknown, stack?: string): void {
  reportLog("error", message, stack);
}

function flush(useBeacon: boolean): void {
  if (!queue.length) return;
  const logs = queue.splice(0, MAX_QUEUE).map((l) => ({
    ...l,
    url: window.location.href.slice(0, 200),
    canvas_id: currentCanvasId(),
  }));
  const body = JSON.stringify({ logs });
  try {
    if (useBeacon && navigator.sendBeacon) {
      // 页面卸载路径：sendBeacon 不阻塞卸载
      navigator.sendBeacon(
        `${API_BASE}/client_logs`,
        new Blob([body], { type: "application/json" })
      );
    } else {
      void fetch(`${API_BASE}/client_logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        /* 上报失败静默丢弃 */
      });
    }
  } catch {
    /* 上报失败静默丢弃 */
  }
}

/**
 * 安装全局错误捕获（幂等，main.tsx 里调用一次）：
 * - window.onerror：运行时 JS 错误 + 资源加载失败
 * - unhandledrejection：未捕获的 Promise 拒绝
 * - pagehide / visibilitychange：页面离开前尽力把队列推走
 */
export function installGlobalErrorReporting(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    // DOM 类型声明里 "error" 固定为 ErrorEvent，但资源加载失败实际派发的是
    // 普通 Event（target 为出错的 img/script），需联合处理两种形态
    const evt = e as ErrorEvent | Event;
    if (evt instanceof ErrorEvent) {
      const stack = evt.error instanceof Error ? evt.error.stack : undefined;
      reportError(
        `${evt.message} @ ${evt.filename}:${evt.lineno}:${evt.colno}`,
        stack
      );
    } else {
      const tag = (evt.target as HTMLElement | null)?.tagName ?? "unknown";
      const src =
        (evt.target as HTMLImageElement | HTMLScriptElement | null)?.src ?? "";
      reportLog("warn", `资源加载失败: <${tag}> ${src.slice(0, 200)}`);
    }
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportError(`未处理的 Promise 拒绝: ${message}`, stack);
  });

  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });

  window.setInterval(() => flush(false), FLUSH_MS);
}
