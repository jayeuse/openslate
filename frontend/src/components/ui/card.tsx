import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      data-slot="card"
      className={cn(
        "border-card-edge bg-card text-card-foreground shadow-card self-start rounded-[var(--radius)] border",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-border flex flex-col gap-1.5 border-b p-5",
        className,
      )}
      {...props}
    />
  );
}
export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}
export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}
export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-border flex items-center gap-2 border-t p-5",
        className,
      )}
      {...props}
    />
  );
}
