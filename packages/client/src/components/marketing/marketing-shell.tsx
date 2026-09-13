import * as React from "react";
import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { SignedInRedirect } from "@/components/marketing/signed-in-redirect";
import { OPENAPI_URL, REPO_URL } from "@/lib/site-links";

const NAV = [
  { href: "/extension/", label: "Chrome" },
  { href: "/raycast/", label: "Raycast" },
  { href: "/mobile/", label: "iPhone & Android" },
] as const;

/**
 * The chrome around every public page: a header with the three client pages,
 * and a footer with the legal and developer links.
 *
 * `data-marketing` is what `styles/native.css` hides inside the Capacitor
 * shell. The native app opens on `/`, and the first frame it paints must not be
 * a landing page for the app the person is already holding.
 */
export function MarketingShell({
  children,
  redirectSignedIn = false,
}: {
  children: React.ReactNode;
  /** Send a signed-in visitor to /track. Only the landing page does this. */
  redirectSignedIn?: boolean;
}): React.ReactElement {
  return (
    <div data-marketing className="flex min-h-screen flex-col">
      {redirectSignedIn && <SignedInRedirect />}
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
          <Link href="/" className="inline-flex items-center gap-2" data-testid="marketing-home">
            <BrandMark label={null} className="size-7" />
            <span className="text-xl font-semibold tracking-tight">
              Track Your <span className="text-brand">Time</span>
            </span>
          </Link>
          <nav className="order-3 flex w-full gap-5 text-sm text-muted-foreground sm:order-none sm:w-auto">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-foreground">
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <Link href="/login/" className="text-muted-foreground hover:text-foreground">
              Log in
            </Link>
            <Link
              href="/signup/"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Create an account
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t text-sm text-muted-foreground">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 sm:grid-cols-3">
          <div className="space-y-2">
            <p className="font-medium text-foreground">Track Your Time</p>
            <p>Open-source time tracking on your own server.</p>
          </div>
          <ul className="space-y-2">
            <li><Link href="/extension/" className="hover:text-foreground">Chrome extension</Link></li>
            <li><Link href="/raycast/" className="hover:text-foreground">Raycast extension</Link></li>
            <li><Link href="/mobile/" className="hover:text-foreground">iPhone and Android</Link></li>
          </ul>
          <ul className="space-y-2">
            <li><a href={REPO_URL} className="hover:text-foreground">Source code</a></li>
            <li><a href={OPENAPI_URL} className="hover:text-foreground">API specification</a></li>
            <li><Link href="/privacy/" className="hover:text-foreground">Privacy policy</Link></li>
            <li><Link href="/support/" className="hover:text-foreground">Support</Link></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
