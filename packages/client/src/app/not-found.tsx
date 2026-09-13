import type { Metadata } from "next";
import Link from "next/link";

import { BrandLockup } from "@/components/brand-lockup";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

/**
 * The 404 for every host. The static export writes it to `out/404.html`,
 * which `serve.mjs` sends with a real 404 status.
 *
 * Deliberately NOT inside `MarketingShell`: that shell is hidden inside the
 * Capacitor app (`data-marketing` in native.css), and a phone that follows a
 * stale link must see a way back, not a blank screen. So the page offers the
 * tracker first — the one destination that is right on every host.
 */
export default function NotFound(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6" data-testid="not-found">
        <Link href="/" aria-label="Track Your Time home">
          <BrandLockup />
        </Link>
        <div className="space-y-3">
          <p className="text-sm font-medium text-brand">404</p>
          <h1 className="text-3xl font-semibold tracking-tight">This page does not exist</h1>
          <p className="leading-relaxed text-muted-foreground">
            The address may be mistyped, or the page moved. Your tracked time is not affected.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/track/"
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open the tracker
          </Link>
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-md border px-5 text-sm font-medium hover:bg-accent"
          >
            Go to the home page
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Followed a link from Track Your Time itself?{" "}
          <Link href="/support/" className="text-foreground underline underline-offset-4">
            Tell us
          </Link>{" "}
          so we can fix it.
        </p>
      </div>
    </main>
  );
}
