import { useEffect, useState } from "react";

const KEY = "tm:darkMode";

function getInitial(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) return stored === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}

export function useDarkMode() {
  const [dark, setDark] = useState(getInitial);

  useEffect(() => {
    applyDark(dark);
    try { localStorage.setItem(KEY, String(dark)); } catch {}
  }, [dark]);

  // Apply on first mount before paint
  useEffect(() => { applyDark(getInitial()); }, []);

  return { dark, toggle: () => setDark((d) => !d) };
}
