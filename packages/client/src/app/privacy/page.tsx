import type { Metadata } from "next";

import { Hero, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { pageMetadata } from "@/lib/page-metadata";
import { CONTACT_EMAIL, REPO_URL } from "@/lib/site-links";

export const metadata: Metadata = pageMetadata({
  title: "Privacy policy",
  description:
    "What the hosted tracktime service stores, why, who else sees it, and how to get it back or have it deleted.",
  path: "/privacy/",
});

/** Bump when the policy changes in substance. Store listings link to this page. */
const LAST_UPDATED = "13 September 2026";

function Block({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Section title={title} className="py-8">
      <div className="max-w-2xl space-y-4 leading-relaxed text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_ul]:space-y-2">
        {children}
      </div>
    </Section>
  );
}

export default function PrivacyPage(): React.ReactElement {
  return (
    <MarketingShell>
      <Hero eyebrow={`Last updated ${LAST_UPDATED}`} title="Privacy policy">
        <p>
          This policy covers the hosted tracktime service at trackyourtime.dev and
          api.trackyourtime.dev, and the tracktime apps and extensions when they connect to it. If
          you run your own tracktime server, your data goes to your server, and this policy does
          not apply to it.
        </p>
        <p>
          tracktime is run by Rico Trebeljahr. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">
            {CONTACT_EMAIL}
          </a>{" "}
          with any question about your data.
        </p>
      </Hero>

      <Block title="The short version">
        <ul>
          <li>tracktime stores your account and the time you track, so that it can show them back to you.</li>
          <li>It runs no analytics, shows no ads, and sells no data.</li>
          <li>It does not track what you do in other apps or on other websites.</li>
          <li>You can export all of your data at any time, and ask for all of it to be deleted.</li>
        </ul>
      </Block>

      <Block title="What the service stores">
        <p>
          <strong>Your account.</strong> Your name, your email address, and a hash of your password.
          The server never stores the password itself.
        </p>
        <p>
          <strong>What you track.</strong> Time entries and their descriptions, clients, projects,
          tasks, tags, favorites, hourly rates, budgets, invoices and imported files. You type all of
          this in yourself.
        </p>
        <p>
          <strong>Your settings.</strong> Currency, week start, clock format, idle handling and
          similar preferences.
        </p>
        <p>
          <strong>Your sessions.</strong> For each device you sign in on: the IP address and browser
          or app identifier it signed in from, and the name of the tracktime client. This is what
          Settings → Devices shows you, so you can recognise a device and sign it out.
        </p>
        <p>
          <strong>API tokens and webhooks</strong>, if you create them: a hash of each token, its
          scopes, and the addresses your webhooks send to, with a record of each delivery.
        </p>
        <p>
          <strong>Request logs.</strong> The server logs each request with the IP address, the time,
          the address requested and the browser identifier. The logs exist to find and fix faults
          and are used for nothing else.
        </p>
      </Block>

      <Block title="Why the service stores it">
        <p>
          The service needs your account and your tracked time to do what you signed up for. That is
          the legal basis for storing them: the service you asked for cannot work without them.
        </p>
        <p>
          Session records and request logs keep the service secure and working. That is a legitimate
          interest of the service and of every person who uses it.
        </p>
        <p>
          The newsletter is the one exception. It sends you nothing unless you subscribe and then
          confirm the subscription by email. You can unsubscribe from any issue.
        </p>
      </Block>

      <Block title="Who else processes it">
        <ul>
          <li>
            <strong>Cloudflare</strong> answers DNS for trackyourtime.dev and passes every request
            to the server. It sees your IP address and the request.
          </li>
          <li>
            <strong>Amazon Web Services (SES)</strong> delivers email: password resets and, if you
            subscribe, the newsletter. It receives your email address and the message.
          </li>
          <li>
            <strong>The server host</strong> rents out the virtual server that runs tracktime and its
            database. Your data is stored on that server.
          </li>
        </ul>
        <p>No other company receives your data. tracktime does not use advertising or analytics services.</p>
      </Block>

      <Block title="The browser extension">
        <ul>
          <li>
            The extension stores your session token and any unsent changes in Chrome&rsquo;s
            extension storage on your computer.
          </li>
          <li>
            The <strong>cookies</strong> permission reads one cookie: the tracktime web app&rsquo;s
            session cookie, so you do not sign in twice. The extension reads no other cookie.
          </li>
          <li>
            The <strong>idle</strong> permission tells the extension that the computer is idle or
            locked. The extension uses it only to ask what to do with idle time. It does not send
            idle state anywhere.
          </li>
          <li>The extension talks only to api.trackyourtime.dev. It cannot read the pages you visit.</li>
          <li>
            The use of information received from Chrome APIs adheres to the Chrome Web Store User Data
            Policy, including the Limited Use requirements.
          </li>
        </ul>
      </Block>

      <Block title="The Raycast extension">
        <p>
          The Raycast extension stores your session token, a copy of recent data, and any unsent
          changes in Raycast&rsquo;s encrypted local storage on your Mac. It talks only to the
          tracktime server set in its preferences.
        </p>
      </Block>

      <Block title="The iPhone and Android apps">
        <ul>
          <li>The apps keep your session token in the iOS Keychain or the Android Keystore.</li>
          <li>
            Unsent changes and the running timer are stored in the app&rsquo;s own storage on the
            phone, so that they survive a restart with no signal.
          </li>
          <li>
            The apps read the phone&rsquo;s network state to know if they are online. They do not
            use your location, contacts, camera, microphone or photos.
          </li>
          <li>The apps contain no advertising, analytics or tracking code.</li>
        </ul>
      </Block>

      <Block title="How long it is kept">
        <p>
          Your account and tracked time are kept until you delete them or ask for them to be deleted.
          A browser session ends 7 days after its last use. A session in an app or extension ends
          30 days after its last use. Either ends at once when you sign the device out.
        </p>
      </Block>

      <Block title="Your rights">
        <p>
          <strong>Get a copy.</strong> Settings → Data exports everything as JSON or CSV, at any
          time, without asking anyone.
        </p>
        <p>
          <strong>Correct it.</strong> You can edit every entry and every setting yourself.
        </p>
        <p>
          <strong>Delete it.</strong> Open Settings → Account → Delete account, in the web app or
          in the phone apps, and confirm with your password. The account, every session and
          everything in your workspace are deleted at once. Every signed-in device is signed out.
        </p>
        <p>
          If you cannot sign in, write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">
            {CONTACT_EMAIL}
          </a>{" "}
          from the email address on your account. The account is then deleted within 30 days, and
          you receive a confirmation.
        </p>
        <p>
          If you live in the EU or the UK, you also have the right to object, to restrict processing,
          and to complain to your data protection authority.
        </p>
      </Block>

      <Block title="Children">
        <p>tracktime is a tool for work. It is not directed at children under 16.</p>
      </Block>

      <Block title="Changes to this policy">
        <p>
          The date at the top changes when this policy changes. The full history of this page is
          public in the{" "}
          <a href={REPO_URL} className="text-foreground underline underline-offset-4">
            source repository
          </a>
          .
        </p>
      </Block>
      <div className="pb-16" />
    </MarketingShell>
  );
}
