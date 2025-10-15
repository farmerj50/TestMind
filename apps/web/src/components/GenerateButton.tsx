// apps/web/src/components/GenerateButton.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  projectId: string;
  defaultBaseUrl?: string;
  onDone?: () => void;
};

export default function GenerateButton({
  projectId,
  defaultBaseUrl = "http://localhost:3000",
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const adapterId = (localStorage.getItem("tm-adapterId") || "playwright-ts") as string;

  async function handleGenerate() {
    setBusy(true);
    try {
      const res = await fetch("/tm/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // NOTE: pass a known-good absolute path on the API host to rule out path issues
          // replace this with your real checkout path if different
          repoPath: "D:\\\\Project\\\\testmind",
          baseUrl: defaultBaseUrl,
          adapterId,
        }),
      });

      if (!res.ok) {
        // pull structured error from the API
        let msg = `Generate failed (HTTP ${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
          if (data?.stack) console.error(data.stack);
        } catch {
          const text = await res.text().catch(() => "");
          if (text) msg = `${msg}: ${text}`;
        }
        throw new Error(msg);
      }

      onDone?.();
    } catch (e: any) {
      console.error(e);
      alert(e.message || "Generate failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleGenerate} title="Generate tests" disabled={busy}>
      <span className="sr-only">Generate</span>
      <svg viewBox="0 0 24 24" className="h-4 w-4">
        <path fill="currentColor" d="M8 5v14l11-7z" />
        <path fill="currentColor" d="M4 11h3v2H4z" />
      </svg>
    </Button>
  );
}
