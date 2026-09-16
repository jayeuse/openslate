import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

export type PaginationControlsProps = {
  ariaLabel: string;
  className?: string;
  pageCount: number;
  pageIndex: number;
  onPageIndexChange: (pageIndex: number) => void;
  variant?: "compact" | "numbered";
};

export function PaginationControls({
  ariaLabel,
  className,
  pageCount,
  pageIndex,
  onPageIndexChange,
  variant = "numbered",
}: PaginationControlsProps) {
  if (pageCount <= 1) return null;

  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);

  function goTo(nextPageIndex: number) {
    onPageIndexChange(Math.min(Math.max(nextPageIndex, 0), pageCount - 1));
  }

  return (
    <Pagination
      className={cn("mx-0 w-full justify-start", className)}
      aria-label={ariaLabel}
    >
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label="Go to previous page"
            disabled={safePageIndex === 0}
            className="min-h-11 min-w-11 gap-1 px-2.5 sm:pl-2.5"
            onClick={() => {
              if (safePageIndex > 0) goTo(safePageIndex - 1);
            }}
          >
            <ChevronLeft aria-hidden="true" />
            <span className="hidden sm:block">Previous</span>
          </Button>
        </PaginationItem>
        {variant === "compact" ? (
          <PaginationItem>
            <Button
              asChild
              variant="outline"
              size="default"
              aria-label={`Page ${safePageIndex + 1} of ${pageCount}`}
              aria-current="page"
              className="min-h-11 min-w-11"
            >
              <span>
                {safePageIndex + 1} / {pageCount}
              </span>
            </Button>
          </PaginationItem>
        ) : (
          getPageLinkItems(pageCount, safePageIndex).map((item, index) =>
            item === "ellipsis" ? (
              <PaginationItem key={`ellipsis-${index}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={item}>
                <Button
                  type="button"
                  variant={item === safePageIndex ? "outline" : "ghost"}
                  size="icon"
                  aria-label={`Page ${item + 1} of ${pageCount}`}
                  aria-current={item === safePageIndex ? "page" : undefined}
                  className="min-h-11 min-w-11"
                  onClick={() => goTo(item)}
                >
                  {item + 1}
                </Button>
              </PaginationItem>
            ),
          )
        )}
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label="Go to next page"
            disabled={safePageIndex === pageCount - 1}
            className="min-h-11 min-w-11 gap-1 px-2.5 sm:pr-2.5"
            onClick={() => {
              if (safePageIndex < pageCount - 1) goTo(safePageIndex + 1);
            }}
          >
            <span className="hidden sm:block">Next</span>
            <ChevronRight aria-hidden="true" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

export function getPageLinkItems(
  pageCount: number,
  pageIndex: number,
): Array<number | "ellipsis"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);

  const indexes = new Set([0, pageCount - 1, pageIndex]);
  if (pageIndex > 0) indexes.add(pageIndex - 1);
  if (pageIndex < pageCount - 1) indexes.add(pageIndex + 1);
  const sorted = [...indexes].sort((left, right) => left - right);
  const items: Array<number | "ellipsis"> = [];
  sorted.forEach((index, position) => {
    if (position > 0 && index - sorted[position - 1]! > 1) {
      items.push("ellipsis");
    }
    items.push(index);
  });
  return items;
}
