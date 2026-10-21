// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import sitemap from "@/app/sitemap";
import { GUIDES } from "@/components/marketing/guide-content";
import { LandingPage } from "@/components/marketing/pages/landing-page";
import { SupportPage } from "@/components/marketing/pages/support-page";
import { GuidePage } from "@/components/marketing/pages/guide-page";
import { StructuredData } from "@/components/marketing/structured-data";
import { localizedPath, marketingMetadata } from "@/i18n/marketing";
import { MARKETING_PAGES } from "@/lib/marketing-pages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

describe("public search metadata", () => {
  it("pairs every real English and German route, including translated slugs", () => {
    const entries = sitemap();
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(MARKETING_PAGES.length * 2);
    for (const path of MARKETING_PAGES) for (const locale of ["en", "de"] as const) {
      const localized = localizedPath(locale, path);
      expect(existsSync(resolve("src/app", `.${localized}`, "page.tsx"))).toBe(true);
      expect(entries.find((entry) => entry.url === `https://trackyourtime.dev${localized}`)).toMatchObject({
        lastModified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        alternates: { languages: { en: `https://trackyourtime.dev${path}`, de: `https://trackyourtime.dev${localizedPath("de", path)}`, "x-default": `https://trackyourtime.dev${path}` } },
      });
      const meta = marketingMetadata(locale, { title: "Test", description: "Test", path });
      expect(meta.openGraph?.images).toEqual(meta.twitter?.images);
    }
  });

  it("keeps guide translations and their related routes complete", () => {
    expect(Object.keys(GUIDES.de).sort()).toEqual(Object.keys(GUIDES.en).sort());
    for (const locale of ["en", "de"] as const) for (const [slug, guide] of Object.entries(GUIDES[locale])) {
      expect(MARKETING_PAGES).toContain(`/${slug}/`);
      for (const related of guide.related) expect(MARKETING_PAGES).toContain(`/${related}/`);
      const html = renderToStaticMarkup(<GuidePage locale={locale} slug={slug} />);
      expect(html).toContain(guide.intro.replaceAll("&", "&amp;").replaceAll("'", "&#x27;"));
    }
  });

  for (const locale of ["en", "de"] as const) for (const Page of [LandingPage, SupportPage]) {
    it(`keeps ${Page.name} FAQ schema equal to visible ${locale} answers`, () => {
      const html = renderToStaticMarkup(<Page locale={locale} />);
      const document = new DOMParser().parseFromString(html, "text/html");
      const schemas = [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => JSON.parse(script.textContent!));
      const faq = schemas.find((schema) => schema["@type"] === "FAQPage");
      expect(faq.inLanguage).toBe(locale);
      const visible = [...document.querySelectorAll("dl > div")].map((item) => ({
        question: item.querySelector("dt")?.textContent, answer: item.querySelector("dd")?.textContent,
      }));
      expect(faq.mainEntity).toHaveLength(visible.length);
      for (const item of faq.mainEntity) expect(visible).toContainEqual({ question: item.name, answer: item.acceptedAnswer.text });
      expect(html).not.toContain("aggregateRating");
    });
  }

  it("cannot turn schema text into executable HTML", () => {
    const html = renderToStaticMarkup(<StructuredData data={{ text: '</script><script>alert("x")</script>' }} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(JSON.parse(document.querySelector("script")!.textContent!).text).toBe('</script><script>alert("x")</script>');
  });
});
