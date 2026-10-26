import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  leading,
  badges,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** A mark before the title, such as a department's color. */
  leading?: ReactNode;
  /** Chips after the title, on its line (a level, a state). */
  badges?: ReactNode;
  className?: string;
}) {
  const heading = (
    <h1
      data-slot="page-title"
      className={cn(
        "text-2xl leading-tight font-bold tracking-[-0.025em] sm:text-[1.875rem]",
        (leading || badges) && "min-w-0 truncate",
      )}
    >
      {title}
    </h1>
  );
  return (
    <div
      className={cn(
        "mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className={cn((leading || badges) && "min-w-0")}>
        {leading || badges ? (
          <div className="flex min-w-0 items-center gap-2.5">
            {leading}
            {heading}
            {badges}
          </div>
        ) : (
          heading
        )}
        {description && (
          <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm leading-6">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      )}
    </div>
  );
}
