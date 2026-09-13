import type { Metadata } from "next";

import { Hero, Prose, SecondaryLink, Section, StoreLink } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  title: "Raycast extension",
  description:
    "Start and stop your Track Your Time timer with a hotkey, and see it running in your Mac's menu bar.",
  path: "/raycast/",
});

export default function RaycastPage(): React.ReactElement {
  return (
    <MarketingShell>
      <Hero
        eyebrow="Track Your Time for Raycast"
        title="Track time without leaving the keyboard"
        actions={
          <>
            <StoreLink store="raycast" />
            <SecondaryLink href="/signup/">Create an account</SecondaryLink>
          </>
        }
      >
        <p>
          If you already run your Mac from Raycast, your time tracker belongs there too. Press a
          hotkey to start or stop the timer, and glance at the menu bar to see what&rsquo;s running.
        </p>
      </Hero>

      <Section title="A clock you can&rsquo;t miss">
        <Prose>
          <p>
            A timer is easy to forget, whether it&rsquo;s one you left running or one you never
            started. Track Your Time puts the running time in your menu bar, where you&rsquo;ll see it
            all day. When nothing is running, it can show today&rsquo;s total instead.
          </p>
        </Prose>
      </Section>

      <Section title="One key to start and stop">
        <Prose>
          <p>
            Give the Start / Stop Timer command a hotkey. Press it to stop what&rsquo;s running.
            Press it again to pick up your last task. No window opens either time.
          </p>
        </Prose>
      </Section>

      <Section title="Log the meeting you forgot to time">
        <Prose>
          <p>
            Open Raycast, press <strong>⌘ ⇧ N</strong>, and enter when the meeting started and ended.
            You don&rsquo;t need to open the web app for it.
          </p>
        </Prose>
      </Section>

      <Section title="Works on a plane">
        <Prose>
          <p>
            No Wi-Fi? Start and stop timers anyway. Raycast keeps the changes on your Mac and sends
            them when you&rsquo;re online again.
          </p>
        </Prose>
      </Section>

      <Section title="Connect it in a minute" className="pb-24">
        <Prose>
          <p>
            The first time you open Track Your Time in Raycast, it shows a short code. Approve the
            code in your browser and you&rsquo;re signed in. Reports and invoices stay in the web
            app, one command away.
          </p>
          <p>
            Running your own server? Enter its address in the extension&rsquo;s preferences. No
            rebuild needed.
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
