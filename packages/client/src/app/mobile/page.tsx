import type { Metadata } from "next";

import {
  FactList,
  Feature,
  Hero,
  Prose,
  Section,
  Shot,
  StoreLink,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  title: "iPhone and Android",
  description:
    "The tracktime app for iPhone and Android: the timer, timesheet, calendar, reports and invoices. Starts and stops with no signal are kept and sent later.",
  path: "/mobile/",
});

export default function MobilePage(): React.ReactElement {
  return (
    <MarketingShell>
      <Hero
        eyebrow="tracktime for iPhone and Android"
        title="Track time on your phone, with or without a signal"
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
              alt="The tracktime timer on an Android phone, running against a client project"
              width={645}
              height={1436}
              priority
            />
            <Shot
              src="/marketing/phone-reports.png"
              alt="The weekly summary on an Android phone: hours tracked, billable hours and money earned"
              width={645}
              height={1436}
            />
            <Shot
              src="/marketing/phone-more.png"
              alt="The More menu on an Android phone, listing every screen of the app"
              width={645}
              height={1436}
              className="hidden sm:block"
            />
          </div>
        }
      >
        <p>
          The tracktime app has the same screens as the web app: the timer, the weekly timesheet,
          the calendar, reports and invoices. Start a timer in a tunnel. The phone sends it to the
          server when it has a signal again.
        </p>
      </Hero>

      <Feature title="Three tabs, and every screen behind the third">
        <p>
          <strong>Track</strong> holds the timer and today&rsquo;s entries. <strong>Reports</strong>{" "}
          opens the summary. <strong>More</strong> opens the full menu: timesheet, calendar,
          invoices, clients, projects, tasks, tags and settings.
        </p>
        <p>
          On Android, the back button closes the open dialog first. Then it goes to Track. On Track,
          it leaves the app.
        </p>
      </Feature>

      <Section title="What happens with no signal">
        <FactList
          items={[
            {
              term: "Your changes stay on the phone",
              detail:
                "Starts, stops and edits made offline go into a queue in the app's own storage. iOS does not clear that storage when the phone is low on space.",
            },
            {
              term: "The running timer survives a restart",
              detail:
                "Start a timer in airplane mode and close the app. When you open it again, still offline, the timer is still running.",
            },
            {
              term: "The queue is sent in order",
              detail:
                "When the connection returns, the app sends the queued changes first. Then it asks the server what is running.",
            },
            {
              term: "The app asks the radio, not the browser",
              detail:
                "The app reads the network state from the phone itself, so airplane mode counts as offline at once.",
            },
          ]}
        />
      </Section>

      <Section title="Your hours stay in your account">
        <Prose>
          <p>
            Each queued change records the account that made it. If another person signs in on the
            same phone, the app does not send your changes to their account. It lists them under
            Settings → Devices and lets that person discard them by name.
          </p>
          <p>
            If your session ends while changes are waiting, the app stops sending and keeps the
            changes. Sign in again, and they go out.
          </p>
        </Prose>
      </Section>

      <Section title="Signed in for 30 days, signed out in one minute" className="pb-24">
        <Prose>
          <p>
            The app keeps your session token in the iOS Keychain or the Android Keystore, not in
            ordinary app storage. A session lasts 30 days and renews each day you use the app.
          </p>
          <p>
            Lose the phone? Open Settings → Devices in the web app and sign the phone out. Its next
            request fails, and its live connection closes within a minute.
          </p>
          <p>
            The app has no widgets and sends no notifications. A timer you forget is caught the next
            time you open tracktime.
          </p>
        </Prose>
      </Section>
    </MarketingShell>
  );
}
