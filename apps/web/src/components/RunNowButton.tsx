import { useState } from "react";
import { Button } from "./ui/button";
import { useApi } from "../lib/api";
import { Play } from "lucide-react";

export default function RunNowButton({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone?: () => void;
}) {
  const { apiFetch } = useApi();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      // send ONLY the projectId; no subdir defaults from the client
      await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({ projectId }), // <- no appSubdir here
      });
      onDone?.();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      onClick={handleClick}
      size="sm"
      disabled={loading}
      title="Run now"
      variant="default"
      className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
    >
      <Play className="mr-2 h-4 w-4" />
      {loading ? "Running…" : "Run"}
    </Button>
  );
}
