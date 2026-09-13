import type { Metadata } from "next";

import {
  FactList,
  Feature,
  Hero,
  Prose,
  SecondaryLink,
  Section,
  Shot,
  StoreLink,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";
import { REPO_URL } from "@/lib/site-links";

export const metadata: Metadata = pageMetadata({
  title: "Chrome extension",
  description:
    "Start and stop your tracktime timer from the Chrome toolbar. Log forgotten time, edit entries, and keep tracking with no connection.",
  path: "/extension/",
});

export default function ExtensionPage(): React.ReactElement {
  return (
    <MarketingShell>
      <Hero
        eyebrow="tracktime for Chrome"
        title="Start and stop your timer from the Chrome toolbar"
        actions={
          <>
            <StoreLink store="chrome" />
            <SecondaryLink href={`${REPO_URL}/tree/main/packages/extension`}>
              Build it from source
            </SecondaryLink>
          </>
        }
      >
        <p>
          The tracktime extension opens a small popup with the timer, today&rsquo;s entries and the
          work you track most often. While a timer runs, the toolbar icon shows how long it has
          run: &ldquo;7m&rdquo;, then &ldquo;1h&rdquo;.
        </p>
        <p>
          If you are signed in to the tracktime web app, the extension uses that session. You sign
          in once, and you never paste an API key.
        </p>
      </Hero>

      <Feature
        title="What the popup does"
        shot={
          <Shot
            src="/marketing/extension-popup.png"
            alt="The tracktime extension popup with a timer running and today's entries below it"
            width={1280}
            height={800}
          />
        }
      >
        <p>
          Start a timer and stop it. Continue an earlier entry from the quick-start list, or pin a
          job you do often so it is always at the top.
        </p>
        <p>
          Log time you forgot to track. Edit or delete an entry. Step back through earlier days to
          see what you logged.
        </p>
        <p>
          An entry has a description, a project, a task, tags and a billable flag. The project list
          is grouped by client. If a project, task or tag does not exist yet, create it in the
          popup, and the popup selects it for you.
        </p>
      </Feature>

      <Section title="Descriptions complete from everything you tracked before">
        <Prose>
          <p>
            Type the first letters of a description, and the popup suggests names you used before.
            The search runs on the server, so a description from six months ago still appears.
          </p>
          <p>
            <strong>Tab</strong> takes the suggestion. <strong>Enter</strong> still starts the
            timer. A suggestion taken with <strong>⌘ Enter</strong> also fills in the project, task,
            tags and billable flag from the last entry with that name.
          </p>
        </Prose>
      </Section>

      <Section title="It keeps working with no connection">
        <Prose>
          <p>
            Start and stop timers on a train or a plane. The extension keeps each change on this
            computer and sends the changes in order when the connection returns.
          </p>
          <p>
            When you sign out, the extension deletes any change it has not sent yet. The next person
            who signs in on this computer cannot send your hours to their account.
          </p>
          <p>
            While the connection is open, the popup receives live updates. Stop a timer in the web
            app or on your phone, and the popup shows it at once.
          </p>
        </Prose>
      </Section>

      <Section title="Permissions, and why the extension needs each one">
        <FactList
          items={[
            { term: "storage", detail: "Keeps your session and the queue of unsent changes on this computer." },
            { term: "cookies", detail: "Reads the tracktime web app's session, so you do not sign in a second time." },
            { term: "idle", detail: "Tells the extension that you walked away, so it can ask what to do with that time." },
            { term: "alarms", detail: "Updates the running time on the toolbar icon every 30 seconds." },
            {
              term: "Access to api.trackyourtime.dev",
              detail: "The one server the extension talks to. The extension cannot read the pages you visit.",
            },
          ]}
        />
      </Section>

      <Section title="What stays in the web app" className="pb-24">
        <Prose>
          <p>
            Reports, invoices, the calendar and the management of clients and projects stay in the
            web app. The popup is 380 pixels wide, and a report does not fit in it.
          </p>
          <p>
            Theme, clock format, duration format and idle handling are in the popup&rsquo;s settings.
            They sync with the web app. The settings also list every device signed in to your
            account, and you can sign any of them out.
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
