import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-stone-950 px-6 text-stone-100">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs tracking-[0.24em] text-lime-300 uppercase">
          404 / Not found
        </p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">
          This slate is blank.
        </h1>
        <p className="mt-4 text-stone-400">
          The page you requested does not exist.
        </p>
        <Link
          className="mt-8 inline-flex text-lime-300 underline underline-offset-4"
          href="/"
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
