import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { Play } from "lucide-react";

export default function RunNowButton({
  projectId,
  onDone,
}: { projectId: string; onDone?: () => void }) {
  const { apiFetch } = useApi();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      onDone?.();
    } catch (e) {
      console.error(e);
      // (optional) show a toast
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
