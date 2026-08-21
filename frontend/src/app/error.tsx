"use client";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-stone-950 px-6 text-stone-100">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs tracking-[0.24em] text-red-400 uppercase">
          500 / Application error
        </p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">
          Something went wrong.
        </h1>
        <p className="mt-4 text-stone-400">
          Try the request again or return to the homepage.
        </p>
        <button
          className="mt-8 inline-flex h-11 items-center rounded-md bg-lime-300 px-5 font-medium text-stone-950 hover:bg-lime-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
