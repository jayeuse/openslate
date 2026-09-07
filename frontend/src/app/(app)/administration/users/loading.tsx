import { Skeleton } from "@/components/ui/skeleton";

export default function AdminUsersLoading() {
  return (
    <div role="status" aria-label="Loading people" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-10 w-28" />
      </div>
      <div className="grid gap-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <span className="sr-only">Loading people…</span>
    </div>
  );
}
