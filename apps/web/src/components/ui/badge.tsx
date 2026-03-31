import * as React from "react";

type Props = React.HTMLAttributes<HTMLSpanElement>;
export function Badge({ className = "", ...props }: Props) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs " +
        className
      }
      {...props}
    />
  );
}
