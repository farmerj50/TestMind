// Extracted from SecurityScanPage.tsx's existing external-assessment live-view code so both the
// auth-capture flow and the new Live Security Test page render the same remote-browser
// screencast + input-forwarding UI instead of two copies. Purely presentational — it does
// not open or manage the WebSocket connection itself; the caller owns that (exactly as
// SecurityScanPage.tsx already did) and passes down where frames should render and how
// input events get sent.

export type LiveBrowserViewProps = {
  viewport: { width: number; height: number };
  imgRef: React.RefObject<HTMLImageElement | null>;
  sendInput: (payload: Record<string, unknown>) => void;
  className?: string;
  interactive?: boolean;
};

export function LiveBrowserView({ viewport, imgRef, sendInput, className, interactive = true }: LiveBrowserViewProps) {
  function coords(e: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * viewport.width;
    const y = ((e.clientY - rect.top) / rect.height) * viewport.height;
    return { x, y };
  }

  return (
    <div
      className={className ?? "relative w-full overflow-hidden rounded border border-slate-300 bg-slate-900"}
      style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
      tabIndex={interactive ? 0 : -1}
      onMouseMove={interactive ? (e) => sendInput({ type: "mouse", event: "move", ...coords(e) }) : undefined}
      onMouseDown={interactive ? (e) => sendInput({ type: "mouse", event: "down", ...coords(e) }) : undefined}
      onMouseUp={interactive ? (e) => sendInput({ type: "mouse", event: "up", ...coords(e) }) : undefined}
      onWheel={interactive ? (e) => sendInput({ type: "mouse", event: "wheel", ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY }) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (["Tab"].includes(e.key)) e.preventDefault();
              sendInput({ type: "key", event: "down", key: e.key });
            }
          : undefined
      }
      onContextMenu={(e) => e.preventDefault()}
    >
      <img ref={imgRef} alt="Live session view" draggable={false} className="h-full w-full select-none" />
    </div>
  );
}
