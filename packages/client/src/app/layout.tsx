import type { Metadata, Viewport } from "next";
import { TRPCProvider } from "@/providers/trpc-provider";
import { AuthProvider } from "@/providers/auth-provider";
import { MobileBridgeLoader } from "@/mobile/MobileBridgeLoader";
import { Toaster } from "@/components/ui/sonner";
import { DeployRecovery } from "@/components/deploy-recovery";
import { ExtensionBridge } from "@/components/extension-bridge";
import { OG_IMAGE } from "@/lib/page-metadata";
import { LocaleRoot } from "@/i18n/locale-root";
import { LOCALE_SCRIPT, NATIVE_SHELL_SCRIPT, THEME_SCRIPT } from "./pre-paint";
import "@/styles/globals.css";

const SITE_DESCRIPTION =
  "Free, open-source time tracking with a timer for your browser, your Mac and your phone. It works offline, hosted or on your own server.";

export const metadata: Metadata = {
  // Resolves the card image below to an absolute URL, which every link
  // preview crawler needs and a static export cannot infer from a request.
  metadataBase: new URL("https://trackyourtime.dev"),
  title: {
    default: "Track Your Time",
    template: "%s | Track Your Time",
  },
  description: SITE_DESCRIPTION,
  manifest: "/manifest.json",
  openGraph: { type: "website", siteName: "Track Your Time", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", images: [OG_IMAGE.url] },
};

/**
 * `width=device-width, initial-scale=1` is Next's own default and is merged in
 * underneath this (lib/metadata/default-metadata.js `createDefaultViewport`),
 * so it does not need repeating here.
 *
 * `viewportFit: "cover"` is the gating change for every safe-area rule in
 * styles/native.css: without `viewport-fit=cover` WKWebView letterboxes the
 * page inside the safe area itself and `env(safe-area-inset-*)` resolves to
 * `0px`, so the inset CSS is silently inert rather than wrong.
 *
 * `interactiveWidget: "resizes-content"` makes the software keyboard shrink
 * the layout viewport instead of only the visual one, which is what lets a
 * focused field inside a scrollable dialog be scrolled above the keyboard
 * rather than sitting behind it.
 *
 * Deliberately NOT here: `maximumScale` / `userScalable`. iOS zooms on focus
 * for any field under 16px, and pinning the scale would "fix" that by
 * disabling pinch-zoom for the web app too — an accessibility regression to
 * paper over a font size. native.css sets 16px on native fields instead.
 */
export const viewport: Viewport = {
  themeColor: "#4F46E5",
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NATIVE_SHELL_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LOCALE_SCRIPT }} />
        {/* OpenPanel analytics — replace with your client ID */}
        {process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID && (
          <script
            defer
            async
            src="https://openpanel.dev/op.js"
            data-client-id={process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID}
            data-track-screenviews="true"
          />
        )}
        {process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN && (
          <script
            defer
            data-domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN}
            src={
              process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL ||
              "https://plausible.io/js/script.js"
            }
          />
        )}
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <MobileBridgeLoader />
        <LocaleRoot>
          <TRPCProvider>
            <DeployRecovery />
            <AuthProvider>
              <ExtensionBridge />
              {children}
            </AuthProvider>
          </TRPCProvider>
        </LocaleRoot>
        <Toaster />
      </body>
    </html>
  );
}
