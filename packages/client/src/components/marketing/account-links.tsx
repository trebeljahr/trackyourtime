"use client";

import * as React from "react";
import Link from "next/link";

import { useAuth } from "@/providers/auth-provider";

/**
 * The header's right-hand links: "Log in" and "Create an account" for a
 * visitor, "Open the app" for somebody signed in.
 *
 * The page is prerendered with no session, so the first client render must be
 * the signed-out pair too, or hydration would disagree with the served HTML.
 * The swap happens after mount, once the session has resolved.
 *
 * Labels arrive as props: the public pages translate at build time with
 * `marketingT`, and this is the one client component in the header.
 */
export function AccountLinks({
  logIn,
  createAccount,
  openApp,
}: {
  logIn: string;
  createAccount: string;
  openApp: string;
}): React.ReactElement {
  const { isAuthenticated, isLoading } = useAuth();
  const [mounted, setMounted] = React.useState(false);
  // "Log in" / "Create an account" is what the public pages are prerendered
  // with; swapping in "Open the app" after mount — never during hydration —
  // is what keeps the first client render identical to the served HTML.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setMounted(true), []);

  const primary =
    "rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90";

  if (mounted && !isLoading && isAuthenticated) {
    return (
      <div className="ml-auto flex items-center gap-4 text-sm">
        <Link href="/app/track/" className={primary} data-testid="marketing-open-app">
          {openApp}
        </Link>
      </div>
    );
  }

  return (
    <div className="ml-auto flex items-center gap-4 text-sm">
      <Link href="/login/" className="text-muted-foreground hover:text-foreground" data-testid="marketing-log-in">
        {logIn}
      </Link>
      <Link href="/signup/" className={primary}>
        {createAccount}
      </Link>
    </div>
  );
}
