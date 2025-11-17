import * as React from "react";

type Props = React.HTMLAttributes<HTMLDivElement>;
export function Separator({ className = "", ...props }: Props) {
  return <div className={"my-2 h-px w-full bg-gray-200 " + className} {...props} />;
}
