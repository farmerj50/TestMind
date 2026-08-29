// Extracted from SecurityScanPage.tsx's existing Bug Bounty live-view code so both the
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
};

export function LiveBrowserView({ viewport, imgRef, sendInput, className }: LiveBrowserViewProps) {
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
      tabIndex={0}
      onMouseMove={(e) => sendInput({ type: "mouse", event: "move", ...coords(e) })}
      onMouseDown={(e) => sendInput({ type: "mouse", event: "down", ...coords(e) })}
      onMouseUp={(e) => sendInput({ type: "mouse", event: "up", ...coords(e) })}
      onWheel={(e) => sendInput({ type: "mouse", event: "wheel", ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY })}
      onKeyDown={(e) => {
        if (["Tab"].includes(e.key)) e.preventDefault();
        sendInput({ type: "key", event: "down", key: e.key });
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img ref={imgRef} alt="Live session view" draggable={false} className="h-full w-full select-none" />
    </div>
  );
}
