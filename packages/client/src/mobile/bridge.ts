/*
 * Capacitor (native-mobile) bridge.
 *
 * Loaded dynamically from the client entry so Capacitor symbols stay
 * out of the web bundle. Init is idempotent and all native calls are
 * try-wrapped — a missing plugin or denied permission never crashes
 * the web view.
 */

import type { StatusBar as StatusBarPlugin, Style as StyleEnum } from "@capacitor/status-bar";

export interface MobileHandlers {
  /**
   * Android's hardware back button. Return `true` when the app consumed the
   * press (an overlay was closed, a tab was switched). Returning `false`
   * means "there is nothing left to go back to" and the shell exits.
   */
  onBackButton?: () => boolean;
  onPause?: () => void;
  onResume?: () => void;
}

let initialized = false;

/*
 * The live handler table.
 *
 * `initMobile` latches after its first call, and the first call is
 * `MobileBridgeLoader` at the root of the app — before AppShell exists, and
 * on screens (sign-in) where AppShell never mounts at all. Passing handlers
 * INTO `initMobile` therefore registers nothing: the latch has already
 * closed, and the listeners the old code only added `if (handlers.onResume)`
 * were never added at all.
 *
 * So the listeners are registered unconditionally on the first init and read
 * through this object, which `setMobileHandlers` mutates from a React effect.
 * Registration is independent of the latch, and a handler that arrives late —
 * or is swapped on every route change — is picked up on the next press.
 */
const handlers: MobileHandlers = {};

/**
 * Install handlers for as long as the caller is mounted. Returns the
 * teardown, so an effect can `return setMobileHandlers({ ... })`.
 *
 * Teardown only clears the exact functions it installed. Two components
 * swapping a handler in the same commit (unmount-then-mount ordering is not
 * guaranteed) must not have the outgoing one erase the incoming one.
 */
export function setMobileHandlers(next: MobileHandlers): () => void {
  const keys = Object.keys(next) as (keyof MobileHandlers)[];
  Object.assign(handlers, next);
  return () => {
    for (const key of keys) {
      if (handlers[key] === next[key]) delete handlers[key];
    }
  };
}

/** Light glyphs on a dark app, dark glyphs on a light one. */
function applyStatusBarStyle(
  StatusBar: typeof StatusBarPlugin,
  Style: typeof StyleEnum,
): void {
  const dark = document.documentElement.classList.contains("dark");
  // Capacitor names these for the CONTENT they produce, not the background:
  // `Style.Dark` is light text, for a dark app.
  void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(
    () => {
      /* ignore — a status bar that keeps its old style is cosmetic */
    },
  );
}

export async function initMobile(next: MobileHandlers = {}): Promise<void> {
  if (initialized) {
    if (process.env.NODE_ENV !== "production" && Object.keys(next).length > 0) {
      console.warn(
        "[bridge] initMobile() was called again with handlers, which the " +
          "latch ignores. Use setMobileHandlers() instead.",
      );
    }
    return;
  }
  initialized = true;
  setMobileHandlers(next);

  const [{ Capacitor }, { App }, { StatusBar, Style }] = await Promise.all([
    import("@capacitor/core"),
    import("@capacitor/app"),
    import("@capacitor/status-bar"),
  ]);

  if (!Capacitor.isNativePlatform()) return;

  // app/layout.tsx already did both of these before the first paint — every
  // `html.cap` rule in styles/native.css has to be in force by then or the
  // app lays out once without the safe-area insets and jumps. These stay as
  // the idempotent backstop for the case where that script did not run.
  //
  // <html>, not <body>: the marker moved there so <body> keeps reporting
  // hydration mismatches. Writing it to <body> here would leave the CSS
  // matching nothing at all.
  document.documentElement.classList.add("cap");
  document.documentElement.setAttribute("data-platform", Capacitor.getPlatform());

  // `viewportFit: "cover"` means the WebView reaches under the status bar,
  // so the status bar has no background of its own any more — it sits on top
  // of the app header, and native.css pads the header to leave room. Without
  // overlay the OS reserves an opaque strip in its own colour, which is a
  // white band above a dark header.
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    /* Android-only on some versions; iOS overlays regardless. */
  }

  applyStatusBarStyle(StatusBar, Style);

  // Style.Default asks the OS to choose, and the OS chooses from the SYSTEM
  // appearance — so a phone in light mode running the app in dark mode gets
  // dark glyphs on a near-black header, i.e. an invisible clock. The theme
  // lives in a class on <html> (app/layout.tsx's pre-paint script and
  // components/theme-toggle.tsx), so follow that instead.
  new MutationObserver(() => {
    applyStatusBarStyle(StatusBar, Style);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  // Both listeners are registered whether or not a handler exists yet — see
  // the note on `handlers`. Adding a `backButton` listener also overrides
  // Capacitor's own default, so this callback is now the whole behaviour of
  // the button and has to cover the no-handler case itself.
  App.addListener("backButton", (event) => {
    const onBackButton = handlers.onBackButton;
    if (onBackButton) {
      // The app is in charge. It returns false only when there is nothing
      // left to pop, which on a tab-bar app means exit — NOT `history.back()`.
      // `event.canGoBack` is not the signal it looks like here: a single-page
      // app accumulates history entries just by moving between tabs, so at the
      // root of the app it is nearly always true, and the old
      // `canGoBack === false` guard made back a silent no-op there.
      if (!onBackButton()) App.exitApp();
      return;
    }

    // Nothing registered — the sign-in screen, or a paint before AppShell's
    // effect ran. Fall back to the WebView's own history.
    if (event.canGoBack) window.history.back();
    else App.exitApp();
  });

  App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) handlers.onResume?.();
    else handlers.onPause?.();
  });
}

export async function hideSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch {
    /* ignore */
  }
}

export async function lockOrientation(
  orientation: "portrait" | "landscape",
): Promise<void> {
  try {
    const { ScreenOrientation } = await import(
      "@capacitor/screen-orientation"
    );
    await ScreenOrientation.lock({ orientation });
  } catch {
    /* some devices refuse — leave unlocked */
  }
}

