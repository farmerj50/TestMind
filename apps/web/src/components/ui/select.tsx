import * as React from "react";

/** option shape used internally */
type Option = { value: string; label: React.ReactNode };

type Ctx = {
  value?: string;
  setValue: (v: string) => void;
  options: Option[];
  register: (opt: Option) => void;
};

const SelectCtx = React.createContext<Ctx | null>(null);
function useSelectCtx() {
  const ctx = React.useContext(SelectCtx);
  if (!ctx) throw new Error("Select components must be used inside <Select>");
  return ctx;
}

type SelectRootProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  children: React.ReactNode;
  className?: string;
};

export function Select({
  value,
  defaultValue,
  onValueChange,
  children,
}: SelectRootProps) {
  const [internal, setInternal] = React.useState<string | undefined>(
    defaultValue
  );
  const [options, setOptions] = React.useState<Option[]>([]);

  const setValue = (v: string) => {
    setInternal(v);
    onValueChange?.(v);
  };

  const register = React.useCallback((opt: Option) => {
    setOptions((prev) =>
      prev.some((o) => o.value === opt.value) ? prev : [...prev, opt]
    );
  }, []);

  const ctx: Ctx = {
    value: value ?? internal,
    setValue,
    options,
    register,
  };

  return <SelectCtx.Provider value={ctx}>{children}</SelectCtx.Provider>;
}

type TriggerProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export function SelectTrigger({ className = "", ...props }: TriggerProps) {
  const ctx = useSelectCtx();
  return (
    <select
      className={
        "w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm " +
        "focus:outline-none focus:ring-2 focus:ring-black " +
        className
      }
      value={ctx.value ?? ""}
      onChange={(e) => ctx.setValue(e.target.value)}
      {...props}
    >
      {ctx.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label as any}
        </option>
      ))}
    </select>
  );
}

export function SelectContent({
  children,
}: {
  children: React.ReactNode;
}) {
  // purely declarative container in this shim
  return <>{children}</>;
}

export function SelectItem({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  const ctx = useSelectCtx();
  React.useEffect(() => {
    ctx.register({ value, label: children });
  }, [ctx, value, children]);
  return null; // rendered through <SelectTrigger> options
}

export function SelectValue(_props: { placeholder?: string }) {
  // placeholder handled by native select; no-op to keep API compatible
  return null;
}
