import { dismissTopOverlay } from "@/mobile/overlay-stack";

/** Where the hardware back button comes to rest before it exits the app. */
export const ROOT_TAB = "/app/track";

export type BackButtonDeps = {
  pathname: string;
  navigate: (href: string) => void;
  /** Injected so the decision can be tested without a live overlay stack. */
  dismissOverlay?: () => boolean;
};

/**
 * Android's hardware back button, in priority order:
 *
 *   1. an open overlay — dialog, drawer, sheet — closes;
 *   2. anywhere but the root tab goes to the root tab;
 *   3. at the root there is nothing left, so `false` asks the shell to exit.
 *
 * Step 2 navigates rather than calling `router.back()`. History here is
 * whatever the user has browsed, so `back()` from three screens deep walks
 * backwards through them one at a time instead of returning to Track, and a
 * WebView reload always lands on `/` anyway — which makes the entries that
 * survive a reload not the ones the user would expect. Root-tab-then-exit is
 * the platform convention and it is the one that can be reasoned about.
 *
 * HOW MANY PRESSES THIS TAKES, because it is asked as though it were one.
 * With the soft keyboard up — or a field focused while a hardware keyboard is
 * attached — Android gives the first press to the IME, which dismisses the
 * keyboard; the WebView is never told, so this function is not called and the
 * dialog stays open. The second press arrives here and closes it. With nothing
 * focused it is one press. That ordering is the platform's and it is the one
 * users expect: back takes the keyboard away first.
 *
 * Which is why nothing here touches `@capacitor/keyboard`. Hiding the IME
 * ourselves so that one press could close the dialog would mean stealing the
 * press Android had already spent, leaving the user with a keyboard they
 * cannot dismiss with the button that dismisses keyboards.
 *
 * Returns whether the app consumed the press; `false` means exit.
 */
export function handleBackPress({
  pathname,
  navigate,
  dismissOverlay = dismissTopOverlay,
}: BackButtonDeps): boolean {
  if (dismissOverlay()) return true;
  if (pathname === ROOT_TAB || pathname.startsWith(`${ROOT_TAB}/`)) return false;
  navigate(ROOT_TAB);
  return true;
}
