import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

export type PaginationControlsProps = {
  ariaLabel: string;
  className?: string;
  pageCount: number;
  pageIndex: number;
  onPageIndexChange: (pageIndex: number) => void;
};

export function PaginationControls({
  ariaLabel,
  className,
  pageCount,
  pageIndex,
  onPageIndexChange,
}: PaginationControlsProps) {
  const totalPages = Math.max(1, pageCount);

  const safePageIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);

  function goTo(nextPageIndex: number) {
    onPageIndexChange(Math.min(Math.max(nextPageIndex, 0), totalPages - 1));
  }

  return (
    <Pagination
      className={cn("mx-0 w-full justify-start", className)}
      aria-label={ariaLabel}
    >
      <PaginationContent className="gap-2">
        <PaginationItem>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Go to previous page"
            disabled={safePageIndex === 0}
            className="size-11"
            onClick={() => {
              if (safePageIndex > 0) goTo(safePageIndex - 1);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        </PaginationItem>
        <PaginationItem>
          <span
            aria-current="page"
            aria-label={`Page ${safePageIndex + 1} of ${totalPages}`}
            className="bg-muted flex size-11 items-center justify-center rounded-[var(--radius)] text-sm font-medium tabular-nums"
          >
            {safePageIndex + 1}
          </span>
        </PaginationItem>
        <PaginationItem>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Go to next page"
            disabled={safePageIndex === totalPages - 1}
            className="size-11"
            onClick={() => {
              if (safePageIndex < totalPages - 1) goTo(safePageIndex + 1);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
