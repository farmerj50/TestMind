// apps/web/src/components/RunLogs.tsx
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { useApi } from "../lib/api";

export default function RunLogs({ runId }: { runId: string }) {
  const { apiFetchRaw } = useApi();
  const [type, setType] = useState<"stdout" | "stderr">("stdout");
  const [text, setText] = useState<string>("");

  const load = async (t: "stdout" | "stderr") => {
    const res = await apiFetchRaw(`/runner/test-runs/${runId}/logs?type=${t}`, {
      method: "GET",
      headers: {
        Accept: "text/plain",
      },
    });
    const data = await res.text();
    setText(data ?? "");
  };

  useEffect(() => {
    load(type);
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
