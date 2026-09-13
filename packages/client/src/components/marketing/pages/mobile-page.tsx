import type { Metadata } from "next";

import { Hero, Prose, Section, Shot, StoreLink } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, type Locale } from "@/i18n/marketing";

/**
 * Metadata for one locale of this page. Title and description move to the
 * `marketing` catalog with the rest of the copy; `path` stays the English path.
 */
export const mobileMetadata = (locale: Locale): Metadata =>
  marketingMetadata(locale, {
  title: "iPhone and Android",
  description:
    "Track billable time on your iPhone or Android phone, even without signal. Everything syncs with your laptop.",
  path: "/mobile/",
});

export function MobilePage({ locale }: { locale: Locale }): React.ReactElement {
  return (
    <MarketingShell locale={locale} path="/mobile/">
      <Hero
        eyebrow="Track Your Time for iPhone and Android"
        title="Track time wherever the work happens"
        actions={
          <>
            <StoreLink store="appStore" />
            <StoreLink store="googlePlay" />
          </>
        }
        shot={
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:max-w-4xl">
            <Shot
              src="/marketing/phone-track.png"
              alt="The Track Your Time timer running on a phone"
              width={645}
              height={1436}
              priority
            />
            <Shot
              src="/marketing/phone-reports.png"
              alt="This week's hours and earnings on a phone"
              width={645}
              height={1436}
            />
            <Shot
              src="/marketing/phone-more.png"
              alt="The Track Your Time menu on a phone, with timesheet, calendar and invoices"
              width={645}
              height={1436}
              className="hidden sm:block"
            />
          </div>
        }
      >
        <p>
          Not every billable hour happens at a desk. Start a timer at a client&rsquo;s office, on a
          site visit or on the train home. It&rsquo;s waiting on your laptop when you sit down to
          write the invoice.
        </p>
      </Hero>

      <Section title="No signal? Keep tracking.">
        <Prose>
          <p>
            The app works in airplane mode and in tunnels. Close it and the timer keeps running.
            When you&rsquo;re back online, everything you did offline syncs by itself.
          </p>
        </Prose>
      </Section>

      <Section title="The whole app, not a cut-down version">
        <Prose>
          <p>
            Your timesheet, calendar, reports and invoices are all on your phone. Check this
            month&rsquo;s hours before a client call, or fix yesterday&rsquo;s entries on the way to
            work.
          </p>
        </Prose>
      </Section>

      <Section title="Lost your phone?">
        <Prose>
          <p>
            Open Settings in the web app and sign the phone out. It loses access to your account
            right away.
          </p>
        </Prose>
      </Section>

      <Section title="Using your own server?" className="pb-24">
        <Prose>
          <p>
            The phone apps connect to trackyourtime.dev for now. On your own server, open the web
            app in your phone&rsquo;s browser and add it to your home screen.
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
