import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExtensionPage, extensionMetadata } from "@/components/marketing/pages/extension-page";
import { LandingPage, landingMetadata } from "@/components/marketing/pages/landing-page";
import { MobilePage, mobileMetadata } from "@/components/marketing/pages/mobile-page";
import { PrivacyPage, privacyMetadata } from "@/components/marketing/pages/privacy-page";
import { RaycastPage, raycastMetadata } from "@/components/marketing/pages/raycast-page";
import { SupportPage, supportMetadata } from "@/components/marketing/pages/support-page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

const PAGES = [
  { name: "landing", Page: LandingPage, meta: landingMetadata, title: "Time tracking on your own server" },
  { name: "privacy", Page: PrivacyPage, meta: privacyMetadata, title: "Privacy policy" },
  { name: "support", Page: SupportPage, meta: supportMetadata, title: "Get help with Track Your Time" },
  { name: "extension", Page: ExtensionPage, meta: extensionMetadata, title: "Your timer, one click away" },
  { name: "raycast", Page: RaycastPage, meta: raycastMetadata, title: "Track time without leaving the keyboard" },
  { name: "mobile", Page: MobilePage, meta: mobileMetadata, title: "Track time wherever the work happens" },
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
    expect(html).toContain("Last updated 13 September 2026");
    expect(html).toMatch(/<a href="mailto:[^"]+"[^>]*>[^<]+@[^<]+<\/a>/);
    expect(html).toContain("<strong>Your account.</strong>");
  });

  it("keeps internal links in the page's language", () => {
    const html = renderToStaticMarkup(<SupportPage locale="de" />);
    // next/link drops the trailing slash outside a Next build.
    expect(html).toMatch(/href="\/de\/privacy\/?"/);
    expect(html).toMatch(/href="\/login\/?"/);
  });

  it("describes the preview image in the page's language", () => {
    const images = privacyMetadata("en").openGraph?.images;
    expect(images).toEqual([expect.objectContaining({ url: "/og.png", alt: expect.stringContaining("Track Your Time") })]);
  });
});
