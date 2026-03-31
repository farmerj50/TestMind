import React from "react";
import { LogoLoader } from "./LogoLoader";

type LoadingOverlayProps = {
  open: boolean;
  subtitle?: string;
  showTimer?: boolean;
};

export function LoadingOverlay({ open, subtitle, showTimer }: LoadingOverlayProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/35 backdrop-blur-sm flex items-center justify-center">
      <div className="rounded-2xl bg-black/45 px-7 py-6 shadow-[0_0_30px_rgba(0,0,0,0.35)] border border-white/10">
        <LogoLoader subtitle={subtitle} showTimer={showTimer ?? true} />
      </div>
    </div>
  );
}
