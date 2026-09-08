"use client";
import { useRender } from "@base-ui/react/use-render";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Breadcrumb(props: ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" {...props} />;
}
export function BreadcrumbList({ className, ...props }: ComponentProps<"ol">) {
  return (
    <ol
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm",
        className,
      )}
      {...props}
    />
  );
}
export function BreadcrumbItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}
export function BreadcrumbLink({
  render,
  className,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    render,
    props: {
      ...props,
      className: cn(
        "rounded-sm transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      ),
    },
  });
}
export function BreadcrumbPage({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      aria-current="page"
      className={cn("text-foreground font-normal", className)}
      {...props}
    />
  );
}
export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: ComponentProps<"li">) {
  return (
    <li
      aria-hidden="true"
      role="presentation"
      className={cn("[&_svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

export function BreadcrumbEllipsis({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 items-center justify-center [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      <MoreHorizontal />
    </span>
  );
}
