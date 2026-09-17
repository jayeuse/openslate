"use client";

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <title>OpenSlate — Application error</title>
      </head>
      <body>
        <main>
          <h1>OpenSlate could not load this page.</h1>
          <p>
            Something went wrong while loading the application. Try again or
            return to the homepage.
          </p>
          <button type="button" onClick={retry}>
            Try again
          </button>{" "}
          <a href="/">Return to the homepage</a>
        </main>
      </body>
    </html>
  );
}
