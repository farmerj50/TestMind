import { useEffect, useState } from "react";

export type AdapterId =
  | "playwright-ts"
  | "cypress-js"
  | "cucumber-js"
  | "appium-js";

const ADAPTER_OPTIONS: { id: AdapterId; label: string; disabled?: boolean }[] = [
  { id: "playwright-ts", label: "Playwright (TypeScript)" },
  { id: "cypress-js",    label: "Cypress (JS)",  disabled: true },
  { id: "cucumber-js",   label: "Cucumber (JS)", disabled: true },
  { id: "appium-js",     label: "Appium (JS)",   disabled: true },
];

type Props = {
  value?: AdapterId;
  onChange?: (val: AdapterId) => void;
  className?: string;
};

export default function AdapterDropdown({ value, onChange, className }: Props) {
  const [selected, setSelected] = useState<AdapterId>(value || "playwright-ts");

  // Persist in localStorage so other pages (e.g., TestMind Runner) can read it
  useEffect(() => {
    const saved = localStorage.getItem("tm-adapterId") as AdapterId | null;
    if (!value && saved) setSelected(saved);
  }, [value]);

  useEffect(() => {
    localStorage.setItem("tm-adapterId", selected);
    onChange?.(selected);
  }, [selected, onChange]);

  return (
    <select
      className={`border rounded px-3 py-2 ${className || ""}`}
      value={selected}
      onChange={(e) => setSelected(e.target.value as AdapterId)}
    >
      {ADAPTER_OPTIONS.map((opt) => (
        <option key={opt.id} value={opt.id} disabled={opt.disabled}>
          {opt.label}{opt.disabled ? " — coming soon" : ""}
        </option>
      ))}
    </select>
  );
}
