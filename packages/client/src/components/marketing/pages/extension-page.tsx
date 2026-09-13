import type { Metadata } from "next";

import {
  Bullets,
  Feature,
  Hero,
  Prose,
  SecondaryLink,
  Section,
  Shot,
  StoreLink,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { marketingMetadata, type Locale } from "@/i18n/marketing";
import { SELF_HOSTING_URL } from "@/lib/site-links";

/**
 * Metadata for one locale of this page. Title and description move to the
 * `marketing` catalog with the rest of the copy; `path` stays the English path.
 */
export const extensionMetadata = (locale: Locale): Metadata =>
  marketingMetadata(locale, {
  title: "Chrome extension",
  description:
    "Start and stop your Track Your Time timer from the Chrome toolbar. Add time you forgot, and keep tracking when the connection drops.",
  path: "/extension/",
});

export function ExtensionPage({ locale }: { locale: Locale }): React.ReactElement {
  return (
    <MarketingShell locale={locale} path="/extension/">
      <Hero
        eyebrow="Track Your Time for Chrome"
        title="Your timer, one click away"
        actions={
          <>
            <StoreLink store="chrome" />
            <SecondaryLink href="/signup/">Create an account</SecondaryLink>
          </>
        }
      >
        <p>
          You spend the day in the browser, and your time tracker shouldn&rsquo;t be one more tab to
          hunt for. The Track Your Time extension lives in Chrome&rsquo;s toolbar. Starting a timer takes
          one click, and the icon shows how long it&rsquo;s been running.
        </p>
      </Hero>

      <Feature
        title="Pick up where you left off"
        shot={
          <Shot
            src="/marketing/popup.png"
            alt="The Track Your Time extension popup with a timer running"
            width={760}
            height={1200}
            className="mx-auto max-w-xs"
          />
        }
      >
        <p>
          The work you tracked recently is right there in the popup. Click it to start the same task
          again, or pin the jobs you do every day so they stay at the top.
        </p>
        <p>
          Start typing a description and the extension suggests ones you&rsquo;ve used before. Pick
          one, and it can fill in the client and project from last time too.
        </p>
      </Feature>

      <Section title="Fix the day before you bill it">
        <Prose>
          <p>
            Forgot to start the timer before a call? Add the time afterwards. Look back through
            earlier days and correct anything that looks wrong, without opening the web app.
          </p>
        </Prose>
      </Section>

      <Section title="Keeps tracking when the Wi-Fi doesn&rsquo;t">
        <Prose>
          <p>
            If the connection drops, keep working. The extension saves your changes and sends them
            as soon as you&rsquo;re back online. Stop a timer here, and it&rsquo;s stopped in the
            web app and on your phone too.
          </p>
        </Prose>
      </Section>

      <Section title="No second login">
        <Prose>
          <p>
            Already logged in to Track Your Time in Chrome? The extension uses that login.
            There&rsquo;s no extra password and no API key to copy.
          </p>
        </Prose>
      </Section>

      <Section title="Using your own server?">
        <Prose>
          <p>
            The Chrome Web Store version connects to trackyourtime.dev. To use the extension with
            your own server, build it from source with your server&rsquo;s address. The{" "}
            <a href={`${SELF_HOSTING_URL}#10-the-other-clients`} className="text-foreground underline underline-offset-4">
              self-hosting guide
            </a>{" "}
            shows how.
          </p>
        </Prose>
      </Section>

      <Section title="What the extension can access" className="pb-24">
        <Bullets
          items={[
            "Your Track Your Time login, so you don't have to sign in twice.",
            "Whether your computer is idle, so it can ask what to do with the time you were away.",
            "Storage on your computer, for changes made while you were offline.",
            "Your Track Your Time server. It can't read the websites you visit.",
          ]}
        />
      </Section>
    </MarketingShell>
  );
}
