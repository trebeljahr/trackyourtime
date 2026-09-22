import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_SHORTCUTS } from "@starter/shared";

import { DownloadPage, downloadMetadata } from "@/components/marketing/pages/download-page";
import { ExtensionPage, extensionMetadata } from "@/components/marketing/pages/extension-page";
import { LandingPage, landingMetadata } from "@/components/marketing/pages/landing-page";
import { MobilePage, mobileMetadata } from "@/components/marketing/pages/mobile-page";
import { PrivacyPage, privacyMetadata } from "@/components/marketing/pages/privacy-page";
import { RaycastPage, raycastMetadata } from "@/components/marketing/pages/raycast-page";
import { SupportPage, supportMetadata } from "@/components/marketing/pages/support-page";
import { settings as deSettings } from "@/i18n/messages/de/settings";
import { settings as enSettings } from "@/i18n/messages/en/settings";
import { formatAccelerator, type KeyWords } from "@/lib/desktop-shell";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

const PAGES = [
  { name: "landing", Page: LandingPage, meta: landingMetadata, title: "Open-source time tracking on every device you use" },
  { name: "privacy", Page: PrivacyPage, meta: privacyMetadata, title: "Privacy policy" },
  { name: "support", Page: SupportPage, meta: supportMetadata, title: "Get help with Track Your Time" },
  { name: "extension", Page: ExtensionPage, meta: extensionMetadata, title: "Your timer, one click away" },
  { name: "raycast", Page: RaycastPage, meta: raycastMetadata, title: "Track time without leaving the keyboard" },
  { name: "mobile", Page: MobilePage, meta: mobileMetadata, title: "Track time wherever the work happens" },
  { name: "download", Page: DownloadPage, meta: downloadMetadata, title: "Start the timer from any app on your computer" },
] as const;

describe("public pages in English", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => errors.mockClear());

  for (const { name, Page, meta, title } of PAGES) {
    it(`renders ${name} from the catalog with no missing messages`, () => {
      const html = renderToStaticMarkup(<Page locale="en" />);
      expect(html).toContain(title);
      // A missing or broken message renders as its key: "marketing.privacy.hero.title".
      expect(html).not.toMatch(/marketing\.[a-z]+\.[a-zA-Z.]+/);
      expect(errors).not.toHaveBeenCalled();
      expect(meta("en").description).toBeTruthy();
    });
  }

  it("keeps rich-text links and arguments", () => {
    const html = renderToStaticMarkup(<PrivacyPage locale="en" />);
    expect(html).toContain("Last updated 22 September 2026");
    expect(html).toMatch(/<a href="mailto:[^"]+"[^>]*>[^<]+@[^<]+<\/a>/);
    expect(html).toContain("<strong>Your account.</strong>");
  });

  it("keeps internal links in the page's language", () => {
    const html = renderToStaticMarkup(<SupportPage locale="de" />);
    // next/link drops the trailing slash outside a Next build.
    expect(html).toMatch(/href="\/de\/privacy\/?"/);
    expect(html).toMatch(/href="\/login\/?"/);
  });

  it("offers no desktop download that does not exist", () => {
    const html = renderToStaticMarkup(<DownloadPage locale="en" />);
    // Every channel is null in lib/site-links.ts until a release or a store is live.
    expect(html).toContain("No version is released yet");
    expect(html).not.toMatch(/data-testid="download-(mac|windows|linux|homebrew|macAppStore|microsoftStore|flathub|snapStore)"/);
    expect(html.match(/data-testid="download-pending-/g)).toHaveLength(8);
  });

  // The page spells the default shortcut out as prose, so nothing else would
  // notice if the binding or a key's name changed under it.
  it("names the default shortcut the way the app itself shows it", () => {
    const shown = (platform: string, keys: KeyWords): string =>
      formatAccelerator(DEFAULT_DESKTOP_SHORTCUTS["toggle-timer"]!, platform, keys);
    const en = renderToStaticMarkup(<DownloadPage locale="en" />);
    expect(en).toContain(shown("darwin", enSettings.desktop.shortcuts.keys));
    expect(en).toContain(shown("win32", enSettings.desktop.shortcuts.keys));
    const de = renderToStaticMarkup(<DownloadPage locale="de" />);
    expect(de).toContain(shown("darwin", deSettings.desktop.shortcuts.keys));
    expect(de).toContain(shown("win32", deSettings.desktop.shortcuts.keys));
  });

  it("describes the preview image in the page's language", () => {
    const images = privacyMetadata("en").openGraph?.images;
    expect(images).toEqual([expect.objectContaining({ url: "/og.png", alt: expect.stringContaining("Track Your Time") })]);
  });
});
