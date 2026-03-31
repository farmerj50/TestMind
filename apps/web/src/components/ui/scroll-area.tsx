import * as React from "react";

type Props = React.HTMLAttributes<HTMLDivElement>;
export function ScrollArea({ className = "", ...props }: Props) {
  return <div className={"overflow-auto " + className} {...props} />;
}
