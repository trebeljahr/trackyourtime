import type { Metadata } from "next";
import Link from "next/link";

import {
  FactList,
  Feature,
  Hero,
  PrimaryLink,
  Prose,
  SecondaryLink,
  Section,
  Shot,
} from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";
import { OPENAPI_URL, REPO_URL, SELF_HOSTING_URL } from "@/lib/site-links";

export const metadata: Metadata = pageMetadata({
  title: { absolute: "tracktime — time tracking for billable work" },
  description:
    "Track billable hours by client, project, task and tag. Invoice them, export them, and host it yourself. Open source under AGPL-3.0.",
  path: "/",
});

/**
 * The landing page, and still the app's front door for a signed-in person:
 * `MarketingShell` sends them on to /track once their session resolves. Inside
 * the native shell none of this paints — see `styles/native.css`.
 */
export default function LandingPage(): React.ReactElement {
  return (
    <MarketingShell redirectSignedIn>
      <Hero
        eyebrow="tracktime · time tracking for billable work"
        title="Name the work once. Report on it across every client."
        actions={
          <>
            <PrimaryLink href="/signup/">Start tracking</PrimaryLink>
            <SecondaryLink href={REPO_URL}>Read the source</SecondaryLink>
          </>
        }
        shot={
          <Shot
            src="/marketing/web-track.png"
            alt="The tracktime timer running against a client project, above the day's entries"
            width={1600}
            height={1000}
            priority
          />
        }
      >
        <p>
          In tracktime, a task does not live inside a project. &ldquo;Design review&rdquo; is one
          task, and you use it for every client. So a report can tell you how many hours of design
          review you did this year.
        </p>
        <p className="text-base">
          Free while tracktime is in beta. Built for one person&rsquo;s billable work: there are no
          team features yet.
        </p>
      </Hero>

      <Section title="What tracktime does">
        <Prose>
          <p>
            Start a timer. File the entry under a client, a project and a task, and add tags. Get
            the hours back as a report, a CSV file, a PDF or an invoice.
          </p>
          <p>
            Use it in the browser, from the Chrome toolbar, from Raycast on a Mac, or on your phone.
            All of them use one account. Stop a timer in one place, and it stops everywhere else.
          </p>
        </Prose>
      </Section>

      <Feature
        title="One task name for every project"
        shot={
          <Shot
            src="/marketing/web-reports.png"
            alt="A summary report that groups a month of hours by task across several clients"
            width={1600}
            height={1000}
          />
        }
      >
        <p>
          Many time trackers put each task inside a project. Then you create &ldquo;Design
          review&rdquo; again for every client, and its hours split across all the copies.
        </p>
        <p>
          In tracktime, an entry has a project and a task, and the two are independent. An entry
          can have both, one or neither. When you delete a project, its entries stay and every task
          name stays too.
        </p>
        <p>
          Tags add a third dimension. An entry can carry many tags, and a tag such as
          &ldquo;deep work&rdquo; reports across all your projects.
        </p>
      </Feature>

      <Feature
        reverse
        title="A new rate does not change old entries"
        shot={
          <Shot
            src="/marketing/web-invoice.png"
            alt="An invoice built from a month of billable entries, with line items per project"
            width={1600}
            height={1000}
          />
        }
      >
        <p>
          tracktime copies the hourly rate and the currency onto each entry when you save it. Raise
          a project&rsquo;s rate in March, and your February hours keep the February rate.
        </p>
        <p>
          An invoice collects the billable time that is not on an invoice yet. The server gathers
          the line items again when you create it, and gives it the next number for that year.
        </p>
        <p>
          After that, the project, task, billable flag, start and end of each entry on the invoice
          are locked. Invoices are draft, sent or paid, and export to PDF.
        </p>
      </Feature>

      <Section title="When tracktime cannot know, it tells you">
        <FactList
          items={[
            {
              term: "Reports grouped by tag",
              detail:
                "Each tag gets the full duration of the entry, so the tag rows add up to more than the total. The table says so. Splitting one hour across three tags would invent time.",
            },
            {
              term: "Dates in an imported file",
              detail:
                "03/04 can be March or April. tracktime decides the order for each file. If no date in the file settles it, the preview asks you.",
            },
            {
              term: "Files with hours but no clock times",
              detail:
                "The import places the day's entries one after another. The preview says that the times of day are invented and the day totals are real.",
            },
            {
              term: "Timesheet cells with two entries",
              detail:
                "The weekly grid does not guess which entry a new number is for. It shows the cell read-only, with a breakdown and a link to the entries.",
            },
          ]}
        />
      </Section>

      <Feature title="Your data leaves in a format that comes back in">
        <p>
          The JSON export contains everything, and it names your clients and projects instead of
          using internal ids. It restores into an empty instance.
        </p>
        <p>
          The CSV export uses the exact columns the importer reads. The importer takes a CSV from
          other tools too: it matches each column by its content, not by the name of the app that
          wrote it. Every import is one batch, and you can undo it.
        </p>
      </Feature>

      <Feature title="A REST API and webhooks, on the free product">
        <p>
          The API has 36 operations for entries, clients, projects, tasks, tags and reports. Tokens
          have five scopes. Webhooks cover seven events and carry an HMAC-SHA256 signature.
        </p>
        <p>
          The REST layer calls the same code as the web app. A write through the API sends the same
          live update to your devices and fires the same webhooks as a click in the app.
        </p>
        <p>
          <a href={OPENAPI_URL} className="font-medium text-foreground underline underline-offset-4">
            Read the OpenAPI document
          </a>{" "}
          before you believe anything on this page.
        </p>
      </Feature>

      <Section title="Track from where you work" id="clients">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              href: "/signup/",
              name: "Web app",
              text: "Every screen: timer, weekly timesheet, calendar, reports, invoices, import and export.",
            },
            {
              href: "/extension/",
              name: "Chrome extension",
              text: "The timer in a toolbar popup. Uses your web app session, so you sign in once.",
            },
            {
              href: "/raycast/",
              name: "Raycast on the Mac",
              text: "A menu bar clock, and a hotkey that starts or stops the timer without a window.",
            },
            {
              href: "/mobile/",
              name: "iPhone and Android",
              text: "The full app on your phone. Starts and stops with no signal are kept and sent later.",
            },
          ].map((client) => (
            <Link
              key={client.href}
              href={client.href}
              className="space-y-2 rounded-xl border p-5 hover:bg-accent"
            >
              <p className="font-medium">{client.name}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{client.text}</p>
            </Link>
          ))}
        </div>
      </Section>

      <Section title="What tracktime does not do">
        <FactList
          items={[
            {
              term: "It is not for teams yet",
              detail:
                "tracktime is built for one person's billable work. There is no member list, no roles and no way to invite anyone.",
            },
            {
              term: "It does not watch you",
              detail:
                "No screenshots, no activity levels, no keystroke counts. Idle detection uses your own threshold and asks you what to do with the time.",
            },
            {
              term: "It does not send notifications",
              detail:
                "A timer you forgot on Friday is caught the next time you open tracktime. Nothing messages you on Saturday.",
            },
            {
              term: "It is not project management",
              detail: "Clients and projects, then tasks and tags beside them. No issues, no assignments, no approvals.",
            },
          ]}
        />
      </Section>

      <Feature title="Run it on your own server">
        <p>
          tracktime is open source under AGPL-3.0. One compose file starts the API, the web app,
          MongoDB, Redis and Caddy on one server with one domain.
        </p>
        <p>
          No release is tagged yet, so the first start builds from source. The client build needs
          at least 4 GB of memory.
        </p>
        <p>
          <a href={SELF_HOSTING_URL} className="font-medium text-foreground underline underline-offset-4">
            Read the self-hosting guide
          </a>
        </p>
      </Feature>

      <Section title="Questions">
        <FactList
          items={[
            {
              term: "Is it free?",
              detail:
                "It is free while it is in beta. The price after that is not decided, and this page will not guess one. Self-hosting is free permanently, because the AGPL-3.0 licence grants it.",
            },
            {
              term: "What happens to my data if the project stops?",
              detail:
                "The source is public, and the JSON export restores into a new instance. The worst case is that you run your own copy. Your hours do not disappear.",
            },
            {
              term: "Is the AGPL a problem for my employer?",
              detail:
                "tracktime is an application you run, not a library you build into a product. Running it for your own work triggers no obligation.",
            },
            {
              term: "Do you track me?",
              detail: (
                <>
                  The hosted instance runs no analytics. The{" "}
                  <Link href="/privacy/" className="underline underline-offset-4">
                    privacy policy
                  </Link>{" "}
                  lists every piece of data the server keeps.
                </>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Start tracking, or read the code first" className="pb-24">
        <Prose>
          <p>No card. And an export that gives you everything back if you leave.</p>
        </Prose>
        <div className="mt-6 flex flex-wrap gap-3">
          <PrimaryLink href="/signup/">Create an account</PrimaryLink>
          <SecondaryLink href={REPO_URL}>View the source on GitHub</SecondaryLink>
        </div>
      </Section>
    </MarketingShell>
  );
}
