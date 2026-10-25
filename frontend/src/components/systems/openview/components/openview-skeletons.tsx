import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Layout-matched placeholders for OpenView's cold loads. Each mirrors the
// panel structure, control heights (min-h-11), and row rhythm of the content
// it stands in for, so the swap to real data does not move the page.

const ROWS = ["a", "b", "c", "d", "e", "f"] as const;
const COLUMNS = ["a", "b", "c", "d"] as const;

function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

/** The data-source and saved-view toolbar card in Views. */
export function ViewsToolbarSkeleton() {
  return (
    <div className="bg-card border-card-edge shadow-card flex flex-wrap items-end justify-between gap-3 rounded-[var(--radius)] border p-4 sm:p-5">
      <div className="min-w-0 flex-1 sm:max-w-sm">
        <FieldSkeleton />
        <Skeleton className="mt-2 h-3 w-40" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <FieldSkeleton className="w-56" />
        <Skeleton className="h-11 w-36" />
      </div>
    </div>
  );
}

/** The view controls card and the record table in Views. */
export function ViewsWorkspaceSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card className="flex min-w-0 flex-col gap-4 self-auto p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <Skeleton className="h-6 w-40" />
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-11 w-32" />
            <Skeleton className="h-11 w-36" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-11 min-w-0 flex-1" />
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-28" />
        </div>
      </Card>
      <Card className="min-w-0 self-auto overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="bg-muted/50 grid grid-cols-4 gap-4 border-b px-4 py-3">
          {COLUMNS.map((column) => (
            <Skeleton key={column} className="h-4 w-20" />
          ))}
        </div>
        <div className="divide-y">
          {ROWS.map((row) => (
            <div
              key={row}
              className="grid grid-cols-4 items-center gap-4 px-4 py-3"
            >
              {/* Record cells hold a 44px link, padded by py-3. */}
              {COLUMNS.map((column) => (
                <div key={column} className="flex h-11 items-center">
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** The Charts definition card: four query fields, then its actions. */
export function ChartFormSkeleton() {
  return (
    <Card className="w-full min-w-0 print:hidden">
      <CardContent className="flex flex-col gap-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => (
            <FieldSkeleton key={column} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-32" />
          <Skeleton className="ml-auto h-11 w-36" />
        </div>
      </CardContent>
    </Card>
  );
}

/** The OpenView route's Suspense frame while its URL state is read. */
export function OpenViewLoading() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Opening OpenView"
    >
      <Skeleton className="h-8 w-52" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
