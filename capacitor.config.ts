import type { CapacitorConfig } from "@capacitor/cli";

/*
 * Capacitor (iOS + Android) configuration.
 *
 * The mobile build is produced by `pnpm build:mobile` (scripts/build-mobile.mjs),
 * which runs `next build` against packages/client with NEXT_DIST_DIR=out-mobile
 * and then `cap sync`. Capacitor copies the exported
 * packages/client/out-mobile/ into ios/App/App/public and
 * android/app/src/main/assets/public.
 *
 * webDir is out-mobile rather than the usual out/ on purpose: the web build and
 * the Playwright E2E build both write packages/client/out (the E2E one with a
 * throwaway 127.0.0.1 API port baked in), and `cap run` syncs implicitly — so a
 * shared directory means a test run can silently ship its own bundle into the
 * app. Nothing but scripts/build-mobile.mjs writes out-mobile.
 *
 * appId and appName here are NOT applied to the native projects: `cap add` is a
 * bare template extraction (@capacitor/cli/dist/ios/add.js), so
 * PRODUCT_BUNDLE_IDENTIFIER, CFBundleDisplayName, namespace and applicationId
 * are hand-edited in ios/ and android/ and must be kept in step with these by
 * hand.
 *
 * appName is the home-screen label, so it is the short form "Track Time" rather
 * than the product name "Track Your Time": fifteen characters are truncated
 * under an iOS icon ("Track Your Ti…"). It matches short_name in the web
 * manifest. CFBundleDisplayName and the Android app_name / title_activity_main
 * strings carry the same value, and scripts/build-mobile.mjs asserts they do.
 *
 * Live reload in dev: scripts/android-dev.sh / scripts/ios-dev.sh
 * set CAP_DEV_URL so the WebView loads from the Next dev server
 * on localhost, your LAN, or the hatchkit Tailscale dev URL instead
 * of the bundled export.
 */
const config: CapacitorConfig = {
  appId: "com.trebeljahr.tracktime",
  appName: "Track Time",
  webDir: "packages/client/out-mobile",

  android: {
    allowMixedContent: false,
  },

  /*
   * The WebView's own ground, seen in the overscroll gutters and for the frame
   * between the splash going and the first paint. app/layout.tsx applies the
   * stored theme before paint, so a white value here is a white flash and white
   * rubber-band gutters for every dark-mode user. There is only one value and
   * it cannot follow the theme, so it is the dark ground (`--background` at
   * `0 0% 3.9%`): light-mode users get one dark frame, which reads as the app
   * loading, where the reverse reads as a broken flash.
   */
  backgroundColor: "#0A0A0A",

  ...(process.env.CAP_DEV_URL
    ? {
        server: {
          url: process.env.CAP_DEV_URL,
          cleartext: true,
        },
      }
    : {}),

  plugins: {
    /*
     * `resize: "native"` hands the keyboard's height to the WebView as a real
     * viewport resize, which is what `interactiveWidget: "resizes-content"`
     * in app/layout.tsx needs to have anything to react to. The alternatives
     * are worse in specific ways: "body" resizes the body element and leaves
     * `position: fixed` chrome — the sticky header, the tracker bar, the tab
     * bar stage 3 adds — sitting behind the keyboard, and "none" leaves the
     * focused field behind it instead.
     *
     * The accessory bar stays: it is where "Done" lives, and a numeric
     * TimeField has no other way to dismiss the keyboard.
     */
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },

    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: false,
      backgroundColor: "#0A0A0A",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
};

export default config;
