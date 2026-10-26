import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1
          data-slot="page-title"
          className="text-2xl leading-tight font-bold tracking-[-0.025em] sm:text-[1.875rem]"
        >
          {title}
        </h1>
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
