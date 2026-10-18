import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius)] text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary)_86%,var(--ink))]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-foreground hover:bg-muted",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-[color-mix(in_srgb,var(--destructive)_86%,var(--ink))]",
        // Themes set --button-edge and --button-ink; a call site's own
        // border or text classes still win.
        outline:
          "border border-[color:var(--button-edge,var(--border))] bg-card text-[color:var(--button-ink)] hover:bg-muted",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ComponentPropsWithRef<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** The action is running: the button locks and says so (`aria-busy`). */
  pending?: boolean;
  /** Shown while pending, for example "Saving…". The button keeps the
   * width of its longer label, so the layout never jumps. */
  pendingLabel?: ReactNode;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  pendingLabel,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  // Both labels share one grid cell; the hidden one keeps its width and is
  // left out of the accessible name (visibility: hidden).
  const content =
    pendingLabel === undefined || asChild ? (
      children
    ) : (
      <span className="grid">
        <span
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
            pending && "invisible",
          )}
        >
          {children}
        </span>
        <span
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
            !pending && "invisible",
          )}
        >
          {pendingLabel}
        </span>
      </span>
    );

  return (
    <Component
      data-slot="button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {content}
    </Component>
  );
}
