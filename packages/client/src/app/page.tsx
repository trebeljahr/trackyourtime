import type { Metadata } from "next";
import Link from "next/link";

import {
  Feature,
  Hero,
  PrimaryLink,
  Prose,
  Questions,
  SecondaryLink,
  Section,
  Shot,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";
import { DONATE_URL, OPENAPI_URL, REPO_URL, SELF_HOSTING_URL } from "@/lib/site-links";

export const metadata: Metadata = pageMetadata({
  title: { absolute: "Track Your Time — open-source time tracking on your own server" },
  description:
    "Keep your hours, clients and invoices on a server you control. Open source, with a timer for your browser, your Mac and your phone.",
  path: "/",
});

const CLIENTS = [
  { href: "/signup/", name: "Web app", text: "Timer, timesheet, calendar, reports and invoices." },
  { href: "/extension/", name: "Chrome", text: "A timer in your toolbar. One click to start or stop." },
  { href: "/raycast/", name: "Raycast", text: "A menu bar clock and a start/stop hotkey on your Mac." },
  { href: "/mobile/", name: "iPhone and Android", text: "Track time away from your desk, even without signal." },
] as const;

const link = "text-foreground underline underline-offset-4";

/**
 * The landing page, and still the app's front door for a signed-in person:
 * `MarketingShell` sends them on to /track once their session resolves. Inside
 * the native shell none of this paints — see `styles/native.css`.
 */
export default function LandingPage(): React.ReactElement {
  return (
    <MarketingShell redirectSignedIn>
      <Hero
        eyebrow="Open-source time tracking"
        title="Time tracking on your own server"
        actions={
          <>
            <PrimaryLink href={SELF_HOSTING_URL}>Host it yourself</PrimaryLink>
            <SecondaryLink href="/signup/">Use the hosted version</SecondaryLink>
          </>
        }
        shot={
          <Shot
            src="/marketing/web-track.png"
            alt="The Track Your Time timer running, above a list of today's billable entries"
            width={1600}
            height={1000}
            priority
          />
        }
      >
        <p>
          Track Your Time keeps your hours, clients and invoices on a server you control. It also
          puts a timer in your browser, your Mac&rsquo;s menu bar and your phone, so starting one
          takes a second, even without a connection.
        </p>
        <p className="text-base">Free and open source. The hosted version is free while in beta.</p>
      </Hero>

      <Section title="Your time data belongs to you">
        <Prose>
          <p>
            A time tracker knows who your clients are, what you charge them and how you spend every
            working day. That&rsquo;s worth keeping on a server you control, not in someone
            else&rsquo;s database.
          </p>
          <p>
            One compose file starts everything on a single server, with HTTPS set up for you. The{" "}
            <a href={SELF_HOSTING_URL} className={link}>
              self-hosting guide
            </a>{" "}
            walks through the install, backups, upgrades and email, one step at a time. And you can
            export all of it as JSON or CSV whenever you want.
          </p>
          <p className="text-sm">
            There&rsquo;s no tagged release yet, so the first start builds from source and needs a
            server with 4 GB of memory. Once images are published, 1–2 GB is enough.
          </p>
        </Prose>
      </Section>

      <Feature
        title="A timer you&rsquo;ll actually use"
        shot={
          <Shot
            src="/marketing/popup.png"
            alt="The Track Your Time Chrome extension with a timer running"
            width={760}
            height={1200}
            className="mx-auto max-w-xs"
          />
        }
      >
        <p>
          The hours you forget to track are the hours you don&rsquo;t bill. A tracker that only
          lives in a browser tab is easy to forget, so Track Your Time goes where you already are: a
          click in Chrome, a hotkey on your Mac, a tap on your phone.
        </p>
        <p>
          Lost the connection? Keep tracking. Everything syncs when you&rsquo;re back online, and a
          timer you stop on one device stops on all of them.
        </p>
      </Feature>

      <Feature
        reverse
        title="From hours to invoice"
        shot={
          <Shot
            src="/marketing/web-invoice.png"
            alt="An invoice for one client, with a month of billable hours grouped into line items"
            width={1600}
            height={1000}
          />
        }
      >
        <p>
          Give each project an hourly rate. When it&rsquo;s time to bill, pick a client and a
          month, and Track Your Time turns the unbilled hours into an invoice you can download as a
          PDF.
        </p>
        <p>
          An hour can&rsquo;t be billed twice. And when you raise your rate, the hours you already
          worked keep the rate you agreed on.
        </p>
      </Feature>

      <Feature
        title="See where the time went"
        shot={
          <Shot
            src="/marketing/web-reports.png"
            alt="A report of four weeks of work, split by task, with hours and money earned"
            width={1600}
            height={1000}
          />
        }
      >
        <p>
          Reports show how many hours each client and project took, and what those hours earned.
          Spot the project that has run past its estimate before the client does.
        </p>
        <p>Export any report as a CSV or a PDF when your accountant asks for it.</p>
      </Feature>

      <Section title="Works where you work">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CLIENTS.map((client) => (
            <Link key={client.href} href={client.href} className="space-y-2 rounded-xl border p-5 hover:bg-accent">
              <p className="font-medium">{client.name}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{client.text}</p>
            </Link>
          ))}
        </div>
      </Section>

      <Section title="Free, and nothing held back">
        <Prose>
          <p>
            Track Your Time is licensed under AGPL-3.0. Every feature is in every install. There are
            no paid plugins and no premium tier.
          </p>
          <p>
            It&rsquo;s built by one developer, Rico Trebeljahr, in the open on{" "}
            <a href={REPO_URL} className={link}>
              GitHub
            </a>
            .{" "}
            {DONATE_URL && (
              <>
                If it saves you a subscription,{" "}
                <a href={DONATE_URL} className={link}>
                  you can support development
                </a>
                .
              </>
            )}
          </p>
        </Prose>
      </Section>

      <Section title="Who it&rsquo;s for">
        <Prose>
          <p>
            Freelancers, consultants and small studios who bill by the hour and want to own their
            data. There&rsquo;s no screenshot or keystroke monitoring, and nobody approves your
            timesheet. The app can&rsquo;t invite team members yet, so larger teams may want to
            wait.
          </p>
        </Prose>
      </Section>

      <Section title="Questions">
        <Questions
          items={[
            {
              q: "Do I have to host it myself?",
              a: "No. The hosted version at trackyourtime.dev is open to everyone, and free while in beta. You can move to your own server later: export your data and import it there.",
            },
            {
              q: "What do I need to run it?",
              a: (
                <>
                  A Linux server with Docker, a domain name, and 4 GB of memory for the first build.
                  The{" "}
                  <a href={SELF_HOSTING_URL} className={link}>
                    guide
                  </a>{" "}
                  lists every command.
                </>
              ),
            },
            {
              q: "Can I bring my history from another time tracker?",
              a: "Yes. Export a CSV from your old tool and import it. You see a preview before anything is saved, and you can undo the import.",
            },
            {
              q: "Is there an API?",
              a: (
                <>
                  Yes. A REST API and signed webhooks come with every install. Start with the{" "}
                  <a href={OPENAPI_URL} className={link}>
                    API reference
                  </a>
                  .
                </>
              ),
            },
            {
              q: "What happens if the project stops?",
              a: "Your server keeps running the version you have, and the code stays open source. Nothing depends on a service that could switch off.",
            },
          ]}
        />
      </Section>

      <Section title="Run it on your server, or use ours" className="pb-24">
        <div className="flex flex-wrap gap-3">
          <PrimaryLink href={SELF_HOSTING_URL}>Read the self-hosting guide</PrimaryLink>
          <SecondaryLink href="/signup/">Create a free account</SecondaryLink>
        </div>
      </Section>
    </MarketingShell>
  );
}
