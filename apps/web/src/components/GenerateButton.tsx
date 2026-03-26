import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useApi } from "../lib/api";

type Props = {
  projectId: string;
  defaultBaseUrl?: string;
  onDone?: () => void;
};

const baseUrlKey = (projectId: string) => `tm:baseUrl:${projectId}`;

export default function GenerateButton({ projectId, defaultBaseUrl, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const adapterId = (localStorage.getItem("tm-adapterId") || "playwright-ts") as string;
  const { apiFetch } = useApi();

  async function handleGenerate() {
    let baseUrl = localStorage.getItem(baseUrlKey(projectId)) || defaultBaseUrl || "";

    if (!baseUrl) {
      const entered = window
        .prompt("Enter the Base URL to test (e.g., https://justicepathlaw.com):", "")
        ?.trim();
      if (!entered) {
        toast.error("baseUrl is required");
        return;
      }
      baseUrl = entered;
    }

    if (!/^https?:\/\/.+/i.test(baseUrl)) {
      toast.error("Invalid baseUrl — include http:// or https://");
      return;
    }

    localStorage.setItem(baseUrlKey(projectId), baseUrl);
    localStorage.setItem("tm:lastGeneratedProjectId", projectId);

    setBusy(true);
    const toastId = toast.loading(`Generating tests for ${baseUrl}…`);
    try {
      await apiFetch("/tm/generate", {
        method: "POST",
        body: JSON.stringify({ projectId, baseUrl, adapterId, maxRoutes: 200 }),
      });
      toast.success("Tests generated successfully!", { id: toastId });
      onDone?.();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Generate failed", { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleGenerate}
      title={busy ? "Generating tests…" : "Generate tests"}
      disabled={busy}
    >
      <span className="sr-only">{busy ? "Generating…" : "Generate"}</span>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
    </Button>
  );
}
