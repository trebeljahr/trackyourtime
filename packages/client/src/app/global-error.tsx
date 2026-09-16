"use client";

import { ErrorView } from "@/components/error-view";
import "@/styles/globals.css";

/**
 * The last boundary: an error in the root layout itself, or on a page with no
 * nearer `error.tsx`. It replaces the root layout, so it brings its own
 * `<html>` and `<body>` and its own stylesheet import. The language follows
 * the locale store, which keeps its state when the layout above is gone.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <ErrorView error={error} reset={reset} />
      </body>
    </html>
  );
}
