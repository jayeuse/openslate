import Link from "next/link";

export default function NotFound() {
  return (
    <main className="bg-background text-foreground grid min-h-screen place-items-center px-6">
      <div className="max-w-md text-center">
        <p className="text-primary font-mono text-xs tracking-[0.24em] uppercase">
          404 / Not found
        </p>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          This slate is blank.
        </h1>
        <p className="text-muted-foreground mt-4">
          The page you requested does not exist.
        </p>
        <Link
          className="text-primary mt-8 inline-flex underline underline-offset-4"
          href="/"
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
