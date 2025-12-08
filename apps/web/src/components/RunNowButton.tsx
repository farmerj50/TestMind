import { useState, type ComponentProps } from "react";
import { Button } from "./ui/button";
import { useApi } from "../lib/api";
import { Play } from "lucide-react";

type RunNowButtonProps = {
  projectId: string;
  onDone?: () => void;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children">;

export default function RunNowButton({
  projectId,
  onDone,
  className,
  size = "sm",
  variant = "default",
  ...btnProps
}: RunNowButtonProps) {
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      onClick={handleClick}
      size={size}
      variant={variant}
      disabled={loading || btnProps.disabled}
      title="Run now"
      className={className ?? "bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"}
      {...btnProps}
    >
      <Play className="mr-2 h-4 w-4" />
      {loading ? "Running..." : "Run"}
    </Button>
  );
}
