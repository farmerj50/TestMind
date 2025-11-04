// apps/web/src/components/RunNowButton.tsx
import { useState } from "react";
import { Button } from "./ui/button";      // was "@/components/ui/button"
import { useApi } from "../lib/api";       // was "@/lib/api"
import { Play } from "lucide-react";

export default function RunNowButton({
  projectId,
  appSubdir = "apps/justicepath",         // <- change per project or pass in from parent
  onDone,
}: {
  projectId: string;
  appSubdir?: string;
  onDone?: () => void;
}) {
  const { apiFetch } = useApi();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({ projectId, appSubdir }),  // <- include subdir
      });
      onDone?.();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} size="sm" disabled={loading} title="Run now">
      <Play className="mr-2 h-4 w-4" />
      {loading ? "Running…" : "Run"}
    </Button>
  );
}
