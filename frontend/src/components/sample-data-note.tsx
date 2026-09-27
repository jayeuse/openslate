import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The one label for sample data: an "Example" chip and a line that says what
 * is sample and how long changes last. Screens built on the local sample
 * runtime keep changes in session storage, so they end with the tab.
 */
export function SampleDataNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="note"
      aria-label="Example data"
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm",
        className,
      )}
    >
      <Badge variant="outline">Example</Badge>
      <span>{children} Changes last until you close this tab.</span>
    </p>
  );
}
