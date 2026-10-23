"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A failed read: the destructive alert with Retry inside. The message names
 * what did not load; Retry reads it again.
 */
export function ReadError({
  message,
  retry,
  className,
}: {
  message: string;
  retry: () => void;
  className?: string;
}) {
  return (
    <Alert
      variant="destructive"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}
    >
      <p className="min-w-0 flex-1">{message}</p>
      <Button
        variant="outline"
        className="min-h-11 shrink-0 xl:h-8 xl:min-h-8"
        onClick={retry}
      >
        Retry
      </Button>
    </Alert>
  );
}
