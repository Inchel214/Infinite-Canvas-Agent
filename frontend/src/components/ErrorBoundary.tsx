import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../utils/logger";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局 React 渲染错误边界：任一组件渲染崩溃时展示兜底界面（避免白屏），
 * 并把错误 + 组件堆栈上报到后端日志（backend/data/logs/app.log，[frontend] 标记）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(
      `React 渲染崩溃: ${error.message}`,
      `${error.stack ?? ""}\n组件堆栈:\n${info.componentStack ?? ""}`
    );
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          background: "#141414",
          color: "#eee",
          fontFamily: 'system-ui, "Segoe UI", Roboto, sans-serif',
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 600 }}>页面出错了</div>
        <div
          style={{
            maxWidth: 560,
            fontSize: 13,
            color: "#999",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: "40vh",
            overflow: "auto",
          }}
        >
          {this.state.error.message}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "10px 28px",
            fontSize: 15,
            border: "none",
            borderRadius: 8,
            background: "#7c5cff",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
        <div style={{ fontSize: 12, color: "#777" }}>
          错误详情已自动上报到后端日志
        </div>
      </div>
    );
  }
}
