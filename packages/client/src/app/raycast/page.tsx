import type { Metadata } from "next";

import {
  FactList,
  Feature,
  Hero,
  Prose,
  SecondaryLink,
  Section,
  StoreLink,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";
import { REPO_URL } from "@/lib/site-links";

export const metadata: Metadata = pageMetadata({
  title: "Raycast extension",
  description:
    "A tracktime timer in the macOS menu bar, and a hotkey that starts or stops it without opening a window. Works offline.",
  path: "/raycast/",
});

const COMMANDS = [
  {
    term: "Timer Menu Bar",
    detail: "Shows the running timer in the macOS menu bar, counting by the second.",
  },
  {
    term: "Start / Stop Timer",
    detail:
      "Stops the running timer, or resumes the last entry. Bind it to a hotkey. It never opens a window.",
  },
  {
    term: "Timer",
    detail: "Starts or stops a timer, with your favorites and recent work in one list.",
  },
  {
    term: "Show All Time",
    detail: "Lists your recent entries. Continue, edit or delete any of them.",
  },
  {
    term: "Open Dashboard",
    detail: "Opens the tracktime web app, for reports, invoices and the calendar.",
  },
] as const;

export default function RaycastPage(): React.ReactElement {
  return (
    <MarketingShell>
      <Hero
        eyebrow="tracktime for Raycast"
        title="A timer in your menu bar, and a hotkey that starts it"
        actions={
          <>
            <StoreLink store="raycast" />
            <SecondaryLink href={`${REPO_URL}/tree/main/packages/raycast`}>
              Build it from source
            </SecondaryLink>
          </>
        }
      >
        <p>
          The tracktime extension for Raycast puts the running timer in the macOS menu bar. Give the
          Start / Stop Timer command a hotkey, and one key press stops what is running or resumes
          the last entry.
        </p>
      </Hero>

      <Section title="Five commands">
        <FactList items={COMMANDS} />
      </Section>

      <Feature title="The menu bar shows what you choose">
        <p>
          While a timer runs, the menu bar can show the duration, the description, both, or only the
          icon. When nothing runs, it can show the icon, &ldquo;Start timer&rdquo; or today&rsquo;s
          total.
        </p>
        <p>
          A running clock uses a colon, like <strong>1:05:12</strong>. A total does not, like{" "}
          <strong>36m</strong>. You can see at a glance if a timer is still running.
        </p>
        <p>
          Stop the timer in the web app or on another computer, and the menu bar shows it at once.
          The extension keeps a live connection to the server while a timer runs.
        </p>
      </Feature>

      <Feature title="One form for every entry">
        <p>
          Starting a timer, logging past time and editing an entry use the same five fields:
          description, project, task, tags and billable. Projects are grouped by client.
        </p>
        <p>
          Forgot to start the timer for a meeting? <strong>⌘ ⇧ N</strong> logs past time without
          the web app.
        </p>
        <p>
          Need a new project, task or tag? <strong>⌘ ⇧ P</strong>, <strong>⌘ ⇧ T</strong> or{" "}
          <strong>⌘ ⇧ G</strong> creates it, and the form selects it when you come back.
        </p>
        <p>
          <strong>⌘ ⇧ D</strong> searches every description you used before. Take the name alone,
          or take its project, task, tags and billable flag with it.
        </p>
      </Feature>

      <Section title="It works on a plane">
        <Prose>
          <p>
            Start, stop, log, edit and delete with no network. The extension keeps the changes on
            this Mac and sends them in order when the server answers again. The menu bar shows the
            timer you started offline.
          </p>
          <p>
            Each change records the account that made it. If someone else signs in on this Mac, the
            extension does not send your hours to their account. It shows them how many changes are
            waiting, and lets them discard your changes by name.
          </p>
        </Prose>
      </Section>

      <Section title="Sign in with a code, not an API key" className="pb-24">
        <Prose>
          <p>
            The extension shows a short code. You approve the code in a browser where you are
            signed in to tracktime. The session then appears by name under Settings → Devices in
            the web app, where you can sign it out.
          </p>
          <p>
            Run your own tracktime server? Set the API URL and Web App URL preferences to your
            instance. Leave both empty to use trackyourtime.dev.
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
