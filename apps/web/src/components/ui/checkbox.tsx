import * as React from "react";

type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  /** shadcn/radix-style handler */
  onCheckedChange?: (checked: boolean) => void;
  checked?: boolean;
  defaultChecked?: boolean;
  className?: string;
};

export function Checkbox({
  onCheckedChange,
  className = "",
  ...props
}: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={"h-4 w-4 rounded border-gray-300 text-black focus:ring-black " + className}
      onChange={(e) => {
        onCheckedChange?.(e.currentTarget.checked);
        // still allow consumers to pass a native onChange if they want
        (props as any)?.onChange?.(e);
      }}
      {...props}
    />
  );
}
