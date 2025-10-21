// apps/web/src/components/RunLogs.tsx
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";

export default function RunLogs({ runId }: { runId: string }) {
  const { getToken } = useAuth();
  const [type, setType] = useState<"stdout" | "stderr">("stdout");
  const [text, setText] = useState<string>("");

  const base = import.meta.env.VITE_API_URL as string;

  const load = async (t: "stdout" | "stderr") => {
    const token = await getToken(); // Clerk token for the API
    const res = await fetch(`${base}/runner/test-runs/${runId}/logs?type=${t}`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "text/plain",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const data = await res.text();
    setText(data ?? "");
  };

  useEffect(() => {
    load(type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, type]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          variant={type === "stdout" ? "default" : "outline"}
          size="sm"
          onClick={() => setType("stdout")}
        >
          stdout
        </Button>
        <Button
          variant={type === "stderr" ? "default" : "outline"}
          size="sm"
          onClick={() => setType("stderr")}
        >
          stderr
        </Button>
      </div>

      <pre className="bg-slate-950 text-slate-100 rounded p-3 text-xs overflow-auto max-h-72 whitespace-pre-wrap">
        {text || "—"}
      </pre>
    </div>
  );
}
