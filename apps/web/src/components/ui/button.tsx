import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

const cn = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(" ");

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--tm-accent-soft)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[color:var(--tm-accent)] text-white shadow hover:bg-[color:var(--tm-accent-strong)]",
        destructive: "bg-[color:var(--tm-accent-strong)] text-white shadow-sm hover:bg-[color:var(--tm-accent-strong)]/90",
        outline:
          "border border-[color:var(--tm-accent)] text-[color:var(--tm-accent-strong)] bg-[color:var(--tm-surface)] shadow-sm hover:bg-[color:var(--tm-accent-soft)]",
        secondary:
          "bg-[color:var(--tm-accent)]/90 text-white shadow-sm hover:bg-[color:var(--tm-accent)]",
        ghost: "text-[color:var(--tm-accent-strong)] hover:bg-[color:var(--tm-accent-soft)] hover:text-[color:var(--tm-accent-strong)]",
        link: "text-[color:var(--tm-accent-strong)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
