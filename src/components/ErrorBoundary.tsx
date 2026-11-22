import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 最外层兜底：任何渲染异常都显示可恢复面板，而不是白屏。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[jusong] 界面渲染失败：", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="grid min-h-screen place-items-center bg-paper px-6 text-ink">
        <div className="w-full max-w-md rounded-lg border border-border bg-paper-soft/90 p-8 text-center shadow-paper">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-cinnabar/30 bg-cinnabar/5 font-serif text-xl text-cinnabar">
            沮
          </div>
          <h1 className="mt-4 font-serif text-xl font-semibold tracking-wide">页面暂时无法显示</h1>
          <p className="mt-2 break-words text-sm leading-7 text-ink-soft">
            {this.state.error.message || "发生了未知错误。"}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              className="rounded-md bg-cinnabar px-4 py-2 text-sm text-paper-soft transition-colors hover:bg-cinnabar/90"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
            <a
              className="rounded-md border border-border px-4 py-2 text-sm text-ink transition-colors hover:bg-muted/70"
              href="/"
            >
              回到书架
            </a>
          </div>
        </div>
      </div>
    );
  }
}
