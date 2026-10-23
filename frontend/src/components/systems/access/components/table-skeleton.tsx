import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loading frame of an Access table, drawn as the real card (DESIGN.md,
 * Loading: nothing moves when the data arrives): it fills like the card,
 * with a 36px head, 40px rows (56px list rows on phones) and a footer bar.
 */
export function TableSkeleton({
  columns = 4,
  rows = 10,
}: {
  columns?: number;
  rows?: number;
}) {
  const cells = Array.from({ length: columns }, (_, index) => index);
  const lines = Array.from({ length: rows }, (_, index) => index);
  return (
    <div className="access-fill bg-card flex min-w-0 flex-col overflow-hidden rounded-md border">
      <div className="access-fill hidden min-h-0 flex-col overflow-hidden md:flex">
        <div className="flex h-9 shrink-0 items-center gap-6 border-b px-3">
          {cells.map((cell) => (
            <Skeleton key={cell} className="h-3 w-16" />
          ))}
        </div>
        {lines.map((line) => (
          <div
            key={line}
            className="flex h-10 shrink-0 items-center gap-6 border-b px-3"
          >
            {cells.map((cell) => (
              <Skeleton
                key={cell}
                className={cell === 0 ? "h-4 w-48" : "h-4 w-20"}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="divide-border divide-y md:hidden">
        {lines.slice(0, 6).map((line) => (
          <div key={line} className="flex h-14 items-center gap-3 px-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-auto flex h-12 shrink-0 items-center border-t px-3">
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}
