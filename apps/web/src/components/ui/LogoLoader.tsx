import React, { useEffect, useMemo, useState } from "react";
import testmindLogo from "../../assets/testmind_logo.svg";

type LogoLoaderProps = {
  text?: string;
  subtitle?: string;
  showTimer?: boolean;
  className?: string;
};

export function LogoLoader({
  text = "TestMind AI",
  subtitle,
  showTimer = true,
  className = "",
}: LogoLoaderProps) {
  const startedAt = useMemo(() => Date.now(), []);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    if (!showTimer) return;
    const t = window.setInterval(() => {
      const diff = Math.floor((Date.now() - startedAt) / 1000);
      setSecs(diff);
    }, 250);
    return () => window.clearInterval(t);
  }, [showTimer, startedAt]);

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="tm-fade flex items-center gap-3 select-none">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-white/10 blur-md animate-pulse" />
          <img
            src={testmindLogo}
            alt="TestMind logo"
            className="relative z-10 h-10 w-10 scale-[1.3] rounded-full object-contain bg-black/40 border border-white/10 shadow-[0_0_16px_rgba(255,255,255,0.18)]"
          />
        </div>
        <div className="flex items-center gap-2 leading-tight">
          <div className="text-lg font-semibold text-white">{text}</div>
          <div
            className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white/90 animate-spin"
            aria-hidden="true"
          />
        </div>
      </div>

      {subtitle ? (
        <div className="mt-2 text-xs text-white/70">{subtitle}</div>
      ) : null}

      {showTimer ? (
        <div className="mt-3 text-sm text-white/80 tabular-nums">
          {secs}s
        </div>
      ) : null}
    </div>
  );
}
