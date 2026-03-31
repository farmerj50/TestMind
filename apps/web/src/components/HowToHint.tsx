import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "./ui/button";

type HowToHintProps = {
  storageKey: string;
  title: string;
  steps: string[];
};

export default function HowToHint({ storageKey, title, steps }: HowToHintProps) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const val = localStorage.getItem(storageKey);
    if (val === "hide") setHidden(true);
  }, [storageKey]);

  const hideForever = () => {
    localStorage.setItem(storageKey, "hide");
    setHidden(true);
    setOpen(false);
  };

  if (hidden) return null;

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" className="text-slate-600" onClick={() => setOpen(true)}>
        <Info className="h-4 w-4 mr-1" />
        How to
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/20 flex items-start justify-center p-4">
          <div className="mt-16 w-full max-w-md rounded-lg border bg-white shadow-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{title}</div>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
            <ul className="list-disc pl-4 text-sm text-slate-700 space-y-1">
              {steps.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={hideForever}>
                Don&apos;t show again
              </Button>
              <Button size="sm" onClick={() => setOpen(false)}>
                Got it
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
