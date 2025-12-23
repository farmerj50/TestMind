// apps/web/src/components/GenerateButton.tsx
import { useState } from "react";
import { Button } from "./ui/button";
import { apiUrl } from "../lib/api";

type Props = {
  projectId: string;            // stable ID/slug per project
  defaultBaseUrl?: string;      // optional seed value
  onDone?: () => void;
};

const baseUrlKey = (projectId: string) => `tm:baseUrl:${projectId}`;

export default function GenerateButton({
  projectId,
  defaultBaseUrl,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const adapterId = (localStorage.getItem("tm-adapterId") || "playwright-ts") as string;

  async function handleGenerate() {
    // 1) Load a stored URL or seed from prop
    let baseUrl = localStorage.getItem(baseUrlKey(projectId)) || defaultBaseUrl || "";

    // 2) Prompt once if missing
    if (!baseUrl) {
      const entered = window
        .prompt("Enter the Base URL to test (e.g., https://justicepathlaw.com):", "")
        ?.trim();
      if (!entered) {
        alert("baseUrl is required");
        return;
      }
      baseUrl = entered;
    }

    // 3) Minimal validation
    if (!/^https?:\/\/.+/i.test(baseUrl)) {
      alert("Invalid baseUrl. Include http:// or https://");
      return;
    }

    // 4) Persist for future runs
    localStorage.setItem(baseUrlKey(projectId), baseUrl);

    setBusy(true);
    try {
      const res = await fetch(apiUrl("/tm/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,                 // ← send the actual URL
          adapterId,
          maxRoutes: 200
        }),
      });

      if (!res.ok) {
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
      alert(e?.message || "Generate failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleGenerate}
      title="Generate tests"
      disabled={busy}
    >
      <span className="sr-only">Generate</span>
      <svg viewBox="0 0 24 24" className="h-4 w-4">
        <path fill="currentColor" d="M8 5v14l11-7z" />
        <path fill="currentColor" d="M4 11h3v2H4z" />
      </svg>
    </Button>
  );
}
