"use client";

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
        <button
          className="bg-primary text-primary-foreground focus-visible:outline-ring mt-8 inline-flex h-11 items-center rounded-md px-5 font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
