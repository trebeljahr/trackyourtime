import type { Metadata } from "next";
import Link from "next/link";

import { FactList, Hero, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, type Locale } from "@/i18n/marketing";
import { CONTACT_EMAIL, ISSUES_URL, SELF_HOSTING_URL } from "@/lib/site-links";

/**
 * Metadata for one locale of this page. Title and description move to the
 * `marketing` catalog with the rest of the copy; `path` stays the English path.
 */
export const supportMetadata = (locale: Locale): Metadata =>
  marketingMetadata(locale, {
  title: "Support",
  description: "How to get help with Track Your Time, and answers to the questions people ask most.",
  path: "/support/",
});

const link = "text-foreground underline underline-offset-4";

export function SupportPage({ locale }: { locale: Locale }): React.ReactElement {
  return (
    <MarketingShell locale={locale} path="/support/">
      <Hero eyebrow="Support" title="Get help with Track Your Time">
        <p>
          Email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className={link}>
            {CONTACT_EMAIL}
          </a>
          . Say which client you use (web app, Chrome, Raycast, iPhone or Android) and what you
          expected to happen. One person reads every email.
        </p>
        <p>
          Found a bug, or want a feature? Open an issue on{" "}
          <a href={ISSUES_URL} className={link}>
            GitHub
          </a>
          . Other people can then find the answer too.
        </p>
      </Hero>

      <Section title="Common questions" className="pb-24">
        <FactList
          items={[
            {
              term: "The Chrome extension asks me to sign in, but I am signed in to the web app",
              detail:
                "Open the web app at trackyourtime.dev in the same Chrome profile, then open the popup again. The extension reads the session of that profile only.",
            },
            {
              term: "How do I connect the Raycast extension?",
              detail:
                "Open the Timer command. It shows a code and opens a browser page. Approve the code there while you are signed in to Track Your Time.",
            },
            {
              term: "The app says changes are waiting to sync",
              detail:
                "The changes are safe on the device. They go to the server in order when the device is online and signed in. Do not sign out of an account with waiting changes in the Chrome extension: signing out there deletes them.",
            },
            {
              term: "I lost a phone or a computer",
              detail:
                "Open Settings → Devices in the web app and sign that device out. Its live connection closes within a minute.",
            },
            {
              term: "How do I get all my data out?",
              detail:
                "Settings → Data exports everything as JSON or CSV. The JSON file restores into a new Track Your Time instance.",
            },
            {
              term: "How do I delete my account?",
              detail: (
                <>
                  Open Settings → Account → Delete account and confirm with your password. Export
                  your data first if you want to keep it. The{" "}
                  <Link href="/privacy/" className={link}>
                    privacy policy
                  </Link>{" "}
                  lists what is deleted.
                </>
              ),
            },
            {
              term: "Can I run Track Your Time on my own server?",
              detail: (
                <>
                  Yes. The{" "}
                  <a href={SELF_HOSTING_URL} className={link}>
                    self-hosting guide
                  </a>{" "}
                  covers the first start, email, backups and upgrades.
                </>
              ),
            },
          ]}
        />
      </Section>
    </MarketingShell>
  );
}
