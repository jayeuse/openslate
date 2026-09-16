"use client";

import { Button } from "@/components/ui/button";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="bg-background text-foreground grid min-h-screen place-items-center px-6">
      <div className="max-w-md text-center">
        <p className="text-destructive font-mono text-xs tracking-[0.24em] uppercase">
          500 / Application error
        </p>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          Something went wrong.
        </h1>
        <p className="text-muted-foreground mt-4">
          Try the request again or return to the homepage.
        </p>
        <Button className="mt-8" size="lg" onClick={reset} type="button">
          Try again
        </Button>
      </div>
    </main>
  );
}
