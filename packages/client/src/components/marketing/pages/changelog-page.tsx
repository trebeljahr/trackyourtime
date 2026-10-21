import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Metadata } from "next";
import { Hero, Prose, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, type Locale } from "@/i18n/marketing";
import { REPO_URL } from "@/lib/site-links";

export function changelogMetadata(locale: Locale): Metadata {
  return marketingMetadata(locale, {
    title: locale === "de" ? "Änderungen und Versionshinweise" : "Changelog and release notes",
    description: locale === "de" ? "Versionshinweise aus dem Track-Your-Time-Repository. Funktionen, Fehlerkorrekturen und Migrationen pro Version."
      : "Track Your Time version notes from the source repository. Features, fixes and migrations for each version.",
    path: "/changelog/",
  });
}

/** Small renderer for the changelog's paragraphs, lists and inline emphasis. */
function inline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)]+\))/g).map((part, i) => {
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/);
    return link ? <a key={i} className="underline" href={link[2]}>{link[1]}</a> : part;
  });
}

export function ChangelogPage({ locale }: { locale: Locale }): React.ReactElement {
  // Read during static generation. Unreleased notes do not claim deployed behavior.
  const source = readFileSync(resolve(process.cwd(), "../../CHANGELOG.md"), "utf8");
  const releases = source.split(/^## /m).slice(1).filter((entry) => !entry.startsWith("[Unreleased]"));
  return <MarketingShell locale={locale} path="/changelog/">
    <Hero eyebrow="Track Your Time" title={locale === "de" ? "Änderungen pro Version" : "What changed in each version"}>
      <p>{locale === "de" ? "Die Versionshinweise folgen dem Repository und bleiben auf Englisch. Verfügbarkeit von App- und Store-Versionen kann abweichen."
        : "These notes follow the source repository. Availability of app downloads and store versions can differ."}</p>
      <p><a className="underline" href={`${REPO_URL}/releases`}>{locale === "de" ? "Veröffentlichte Downloads auf GitHub" : "Published downloads on GitHub"}</a></p>
    </Hero>
    {releases.map((release) => {
      const [heading, ...rest] = release.split("\n");
      const blocks = rest.join("\n").trim().split(/\n\s*\n/);
      return <Section key={heading} title={heading.replace(/\[([^\]]+)\]/g, "$1")}>
        <Prose>{blocks.map((block, i) => {
          if (block.startsWith("### ")) return <h3 key={i} className="pt-4 font-semibold text-foreground">{block.slice(4)}</h3>;
          if (block.startsWith("- ")) return <ul key={i} className="list-disc space-y-2 pl-5">
            {block.split(/\n- /).map((item) => <li key={item}>{inline(item.replace(/^- /, "").replace(/\s*\n\s*/g, " "))}</li>)}
          </ul>;
          return <p key={i}>{inline(block.replace(/\s*\n\s*/g, " "))}</p>;
        })}</Prose>
      </Section>;
    })}
  </MarketingShell>;
}
