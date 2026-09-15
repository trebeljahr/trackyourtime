/**
 * English `marketing` messages — the SOURCE catalog for the public pages (landing, privacy, support, extension, raycast, mobile) and their metadata. Rendered at BUILD time in both locales — see i18n/marketing.ts.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/marketing.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 *
 * "Track Your Time", "Chrome", "Raycast", "GitHub" and the host names are
 * names: they stay as they are in every language. Links, e-mail addresses and
 * keyboard shortcuts are passed in as arguments or tags, never written here.
 */
export const marketing = {
  languageSwitch: {
    /** Link to the other language, written in THAT language. */
    toEn: "English",
    toDe: "Deutsch",
    label: "Language",
  },

  /** Shared by every public page's link preview. */
  meta: {
    ogImageAlt: "Track Your Time — open-source time tracking, hosted or on your own server",
  },

  shell: {
    nav: {
      chrome: "Chrome",
      raycast: "Raycast",
      mobile: "iPhone & Android",
      docs: "Docs",
    },
    logIn: "Log in",
    createAccount: "Create an account",
    openApp: "Open the app",
    footer: {
      tagline: "Open-source time tracking, hosted or on your own server.",
      chromeExtension: "Chrome extension",
      raycastExtension: "Raycast extension",
      mobile: "iPhone and Android",
      sourceCode: "Source code",
      docs: "Documentation",
      apiDocs: "REST API",
      privacy: "Privacy policy",
      support: "Support",
    },
  },

  /** Store buttons. `pending` is shown instead of a button while a listing is not live. */
  stores: {
    chrome: { pending: "Not in the Chrome Web Store yet", label: "Add to Chrome" },
    raycast: { pending: "Not in the Raycast Store yet", label: "Install from the Raycast Store" },
    appStore: { pending: "Not on the App Store yet", label: "Download on the App Store" },
    googlePlay: { pending: "Not on Google Play yet", label: "Get it on Google Play" },
  },

  landing: {
    meta: {
      title: "Track Your Time — open-source time tracking, hosted or on your own server",
      description:
        "Track your hours and turn them into invoices and reports. Use it at trackyourtime.dev, or run the same open-source app on your own server.",
    },
    hero: {
      eyebrow: "Open-source time tracking",
      title: "Time tracking on our server or yours",
      hostYourself: "Host it yourself",
      useHosted: "Use the hosted version",
      shotAlt: "The Track Your Time timer running, above a list of today’s billable entries",
      body: "Track Your Time turns your hours into invoices and reports. Use it right here, or run the same open-source app on a server you control. Either way, you get a timer in your browser, your Mac’s menu bar and your phone. Starting one takes a second, even without a connection.",
      beta: "Free and open source. The hosted version is free while in beta.",
    },
    ownership: {
      title: "Hosted or on your own server, it’s the same app",
      why: "A time tracker knows who your clients are, what you charge them and how you spend every working day. You choose where that lives: on trackyourtime.dev, or on a server you run yourself.",
      same: "Both run the same open-source code, with every feature. The Chrome extension, the Raycast extension and the phone apps work with either one. Each asks for a server address, so none of them needs rebuilding.",
      move: "You can change your mind later. Settings → Data moves a workspace from one server to the other, in either direction. And you can export everything as JSON or CSV whenever you want.",
      install:
        "Running your own takes one compose file. It starts everything on a single server, with HTTPS set up for you. The <guide>self-hosting guide</guide> walks through the install, backups, upgrades and email, one step at a time.",
      memory:
        "There’s no tagged release yet, so the first start builds from source and needs a server with 4 GB of memory. Once images are published, 1–2 GB is enough.",
    },
    timer: {
      title: "A timer you’ll actually use",
      shotAlt: "The Track Your Time Chrome extension with a timer running",
      forgotten:
        "The hours you forget to track are the hours you don’t bill. A tracker that only lives in a browser tab is easy to forget, so Track Your Time goes where you already are: a click in Chrome, a hotkey on your Mac, a tap on your phone.",
      offline:
        "Lost the connection? Keep tracking. Everything syncs when you’re back online, and a timer you stop on one device stops on all of them.",
    },
    invoice: {
      title: "From hours to invoice",
      shotAlt: "An invoice for one client, with a month of billable hours grouped into line items",
      rates:
        "Give each project an hourly rate. When it’s time to bill, pick a client and a month, and Track Your Time turns the unbilled hours into an invoice you can download as a PDF.",
      once: "An hour can’t be billed twice. And when you raise your rate, the hours you already worked keep the rate you agreed on.",
    },
    reports: {
      title: "See where the time went",
      shotAlt: "A report of four weeks of work, split by task, with hours and money earned",
      hours:
        "Reports show how many hours each client and project took, and what those hours earned. Spot the project that has run past its estimate before the client does.",
      export: "Export any report as a CSV or a PDF when your accountant asks for it.",
    },
    surfaces: {
      title: "Works where you work",
      web: { name: "Web app", text: "Timer, timesheet, calendar, reports and invoices." },
      chrome: { name: "Chrome", text: "A timer in your toolbar. One click to start or stop." },
      raycast: { name: "Raycast", text: "A menu bar clock and a start/stop hotkey on your Mac." },
      mobile: { name: "iPhone and Android", text: "Track time away from your desk, even without signal." },
    },
    free: {
      title: "Free, and nothing held back",
      license:
        "Track Your Time is licensed under AGPL-3.0. Every feature is in every install. There are no paid plugins and no premium tier.",
      builtBy: "It’s built by one developer, Rico Trebeljahr, in the open on <repo>GitHub</repo>.",
      donate: "If it saves you a subscription, <donate>you can support development</donate>.",
    },
    audience: {
      title: "Who it’s for",
      body: "Freelancers, consultants and small studios who bill by the hour and want to own their data. There’s no screenshot or keystroke monitoring, and nobody approves your timesheet. Invite colleagues by email. Each one sees only their own time until you let them see colleagues’ time or money. You set hourly rates per project, so everyone on a project bills at the same rate.",
    },
    faq: {
      title: "Questions",
      hosting: {
        q: "Do I have to host it myself?",
        a: "No. The hosted version at trackyourtime.dev is open to everyone, and free while in beta. You can move to your own server later from Settings → Data, and back again.",
      },
      requirements: {
        q: "What do I need to run it?",
        a: "A Linux server with Docker, a domain name, and 4 GB of memory for the first build. The <guide>guide</guide> lists every command.",
      },
      import: {
        q: "Can I bring my history from another time tracker?",
        a: "Yes. Export a CSV from your old tool and import it. You see a preview before anything is saved, and you can undo the import.",
      },
      api: {
        q: "Is there an API?",
        a: "Yes. A REST API and signed webhooks come with every install. Start with the <reference>API reference</reference>.",
      },
      shutdown: {
        q: "What happens if the project stops?",
        a: "Your server keeps running the version you have, and the code stays open source. Nothing depends on a service that could switch off.",
      },
    },
    cta: {
      title: "Run it on your server, or use ours",
      guide: "Read the self-hosting guide",
      account: "Create a free account",
    },
  },

  privacy: {
    meta: {
      title: "Privacy policy",
      description:
        "What the hosted Track Your Time service stores, why, who else sees it, and how to get it back or have it deleted.",
    },
    hero: {
      /** `date` is already formatted for the page's language. */
      lastUpdated: "Last updated {date}",
      title: "Privacy policy",
      scope:
        "This policy covers the hosted Track Your Time service at trackyourtime.dev and api.trackyourtime.dev, and the Track Your Time apps and extensions when they connect to it. If you run your own Track Your Time server, your data goes to your server, and this policy does not apply to it.",
      contact: "Track Your Time is run by Rico Trebeljahr. Write to <mail>{email}</mail> with any question about your data.",
    },
    summary: {
      title: "The short version",
      stores: "Track Your Time stores your account and the time you track, so that it can show them back to you.",
      noAnalytics: "It runs no analytics, shows no ads, and sells no data.",
      noTracking: "It does not track what you do in other apps or on other websites.",
      control: "You can export all of your data at any time, and ask for all of it to be deleted.",
    },
    stored: {
      title: "What the service stores",
      account:
        "<strong>Your account.</strong> Your name, your email address, and a hash of your password. The server never stores the password itself.",
      tracked:
        "<strong>What you track.</strong> Time entries and their descriptions, clients, projects, tasks, tags, favorites, hourly rates, budgets, invoices and imported files. You type all of this in yourself.",
      settings:
        "<strong>Your settings.</strong> Currency, week start, clock format, idle handling and similar preferences.",
      sessions:
        "<strong>Your sessions.</strong> For each device you sign in on: the IP address and browser or app identifier it signed in from, and the name of the Track Your Time client. This is what Settings → Devices shows you, so you can recognise a device and sign it out.",
      tokens:
        "<strong>API tokens and webhooks</strong>, if you create them: a hash of each token, its scopes, and the addresses your webhooks send to, with a record of each delivery.",
      logs: "<strong>Request logs.</strong> The server logs each request with the IP address, the time, the address requested and the browser identifier. The logs exist to find and fix faults and are used for nothing else.",
    },
    purpose: {
      title: "Why the service stores it",
      contract:
        "The service needs your account and your tracked time to do what you signed up for. That is the legal basis for storing them: the service you asked for cannot work without them.",
      interest:
        "Session records and request logs keep the service secure and working. That is a legitimate interest of the service and of every person who uses it.",
      newsletter:
        "The newsletter is the one exception. It sends you nothing unless you subscribe and then confirm the subscription by email. You can unsubscribe from any issue.",
    },
    processors: {
      title: "Who else processes it",
      cloudflare:
        "<strong>Cloudflare</strong> answers DNS for trackyourtime.dev and passes every request to the server. It sees your IP address and the request.",
      ses: "<strong>Amazon Web Services (SES)</strong> delivers email: password resets and, if you subscribe, the newsletter. It receives your email address and the message.",
      host: "<strong>The server host</strong> rents out the virtual server that runs Track Your Time and its database. Your data is stored on that server.",
      nobodyElse:
        "No other company receives your data. Track Your Time does not use advertising or analytics services.",
    },
    extension: {
      title: "The browser extension",
      storage:
        "The extension stores your session token and any unsent changes in Chrome’s extension storage on your computer.",
      cookies:
        "The <strong>cookies</strong> permission reads one cookie: the Track Your Time web app’s session cookie, so you do not sign in twice. The extension reads no other cookie.",
      idle: "The <strong>idle</strong> permission tells the extension that the computer is idle or locked. The extension uses it only to ask what to do with idle time. It does not send idle state anywhere.",
      network: "The extension talks only to api.trackyourtime.dev. It cannot read the pages you visit.",
      limitedUse:
        "The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.",
    },
    raycast: {
      title: "The Raycast extension",
      body: "The Raycast extension stores your session token, a copy of recent data, and any unsent changes in Raycast’s encrypted local storage on your Mac. It talks only to the Track Your Time server set in its preferences.",
    },
    mobile: {
      title: "The iPhone and Android apps",
      keychain: "The apps keep your session token in the iOS Keychain or the Android Keystore.",
      storage:
        "Unsent changes and the running timer are stored in the app’s own storage on the phone, so that they survive a restart with no signal.",
      permissions:
        "The apps read the phone’s network state to know if they are online. They do not use your location, contacts, camera, microphone or photos.",
      noTracking: "The apps contain no advertising, analytics or tracking code.",
    },
    retention: {
      title: "How long it is kept",
      body: "Your account and tracked time are kept until you delete them or ask for them to be deleted. A browser session ends 7 days after its last use. A session in an app or extension ends 30 days after its last use. Either ends at once when you sign the device out.",
    },
    rights: {
      title: "Your rights",
      copy: "<strong>Get a copy.</strong> Settings → Data exports everything as JSON or CSV, at any time, without asking anyone.",
      correct: "<strong>Correct it.</strong> You can edit every entry and every setting yourself.",
      delete:
        "<strong>Delete it.</strong> Open Settings → Account → Delete account, in the web app or in the phone apps, and confirm with your password. The account, every session and everything in your workspace are deleted at once. Every signed-in device is signed out.",
      noSignIn:
        "If you cannot sign in, write to <mail>{email}</mail> from the email address on your account. The account is then deleted within 30 days, and you receive a confirmation.",
      eu: "If you live in the EU or the UK, you also have the right to object, to restrict processing, and to complain to your data protection authority.",
    },
    children: {
      title: "Children",
      body: "Track Your Time is a tool for work. It is not directed at children under 16.",
    },
    changes: {
      title: "Changes to this policy",
      body: "The date at the top changes when this policy changes. The full history of this page is public in the <repo>source repository</repo>.",
    },
  },

  support: {
    meta: {
      title: "Support",
      description: "How to get help with Track Your Time, and answers to the questions people ask most.",
    },
    hero: {
      eyebrow: "Support",
      title: "Get help with Track Your Time",
      email:
        "Email <mail>{email}</mail>. Say which client you use (web app, Chrome, Raycast, iPhone or Android) and what you expected to happen. One person reads every email.",
      issues: "Found a bug, or want a feature? Open an issue on <issues>GitHub</issues>. Other people can then find the answer too.",
    },
    faq: {
      title: "Common questions",
      extensionSignIn: {
        term: "The Chrome extension asks me to sign in, but I am signed in to the web app",
        detail:
          "Open the web app at trackyourtime.dev in the same Chrome profile, then open the popup again. The extension reads the session of that profile only.",
      },
      raycastConnect: {
        term: "How do I connect the Raycast extension?",
        detail:
          "Open the Timer command. It shows a code and opens a browser page. Approve the code there while you are signed in to Track Your Time.",
      },
      waitingChanges: {
        term: "The app says changes are waiting to sync",
        detail:
          "The changes are safe on the device. They go to the server in order when the device is online and signed in. Do not sign out of an account with waiting changes in the Chrome extension: signing out there deletes them.",
      },
      lostDevice: {
        term: "I lost a phone or a computer",
        detail:
          "Open Settings → Devices in the web app and sign that device out. Its live connection closes within a minute.",
      },
      export: {
        term: "How do I get all my data out?",
        detail:
          "Settings → Data exports everything as JSON or CSV. The JSON file restores into a new Track Your Time instance.",
      },
      deleteAccount: {
        term: "How do I delete my account?",
        detail:
          "Open Settings → Account → Delete account and confirm with your password. Export your data first if you want to keep it. The <privacy>privacy policy</privacy> lists what is deleted.",
      },
      selfHost: {
        term: "Can I run Track Your Time on my own server?",
        detail: "Yes. The <guide>self-hosting guide</guide> covers the first start, email, backups and upgrades.",
      },
    },
  },

  extension: {
    meta: {
      title: "Chrome extension",
      description:
        "Start and stop your Track Your Time timer from the Chrome toolbar. Add time you forgot, and keep tracking when the connection drops.",
    },
    hero: {
      eyebrow: "Track Your Time for Chrome",
      title: "Your timer, one click away",
      createAccount: "Create an account",
      body: "You spend the day in the browser, and your time tracker shouldn’t be one more tab to hunt for. The Track Your Time extension lives in Chrome’s toolbar. Starting a timer takes one click, and the icon shows how long it’s been running.",
    },
    recent: {
      title: "Pick up where you left off",
      shotAlt: "The Track Your Time extension popup with a timer running",
      recents:
        "The work you tracked recently is right there in the popup. Click it to start the same task again, or pin the jobs you do every day so they stay at the top.",
      suggestions:
        "Start typing a description and the extension suggests ones you’ve used before. Pick one, and it can fill in the client and project from last time too.",
    },
    fixDay: {
      title: "Fix the day before you bill it",
      body: "Forgot to start the timer before a call? Add the time afterwards. Look back through earlier days and correct anything that looks wrong, without opening the web app.",
    },
    offline: {
      title: "Keeps tracking when the Wi-Fi doesn’t",
      body: "If the connection drops, keep working. The extension saves your changes and sends them as soon as you’re back online. Stop a timer here, and it’s stopped in the web app and on your phone too.",
    },
    login: {
      title: "No second login",
      body: "Already logged in to Track Your Time in Chrome? The extension uses that login. There’s no extra password and no API key to copy.",
    },
    selfHost: {
      title: "Using your own server?",
      body: "The extension connects to trackyourtime.dev until you pick another server. Choose Change server below the sign-in form and enter your server’s address. Chrome then asks for access to that one site. The <guide>self-hosting guide</guide> has the details.",
    },
    permissions: {
      title: "What the extension can access",
      login: "Your Track Your Time login, so you don't have to sign in twice.",
      idle: "Whether your computer is idle, so it can ask what to do with the time you were away.",
      storage: "Storage on your computer, for changes made while you were offline.",
      server: "Your Track Your Time server. It can't read the websites you visit.",
    },
  },

  raycast: {
    meta: {
      title: "Raycast extension",
      description:
        "Start and stop your Track Your Time timer with a hotkey, and see it running in your Mac’s menu bar.",
    },
    hero: {
      eyebrow: "Track Your Time for Raycast",
      title: "Track time without leaving the keyboard",
      createAccount: "Create an account",
      body: "If you already run your Mac from Raycast, your time tracker belongs there too. Press a hotkey to start or stop the timer, and glance at the menu bar to see what’s running.",
    },
    menuBar: {
      title: "A clock you can’t miss",
      body: "A timer is easy to forget, whether it’s one you left running or one you never started. Track Your Time puts the running time in your menu bar, where you’ll see it all day. When nothing is running, it can show today’s total instead.",
    },
    hotkey: {
      title: "One key to start and stop",
      /** "Start / Stop Timer" is the Raycast command's name, which stays English. */
      body: "Give the Start / Stop Timer command a hotkey. Press it to stop what’s running. Press it again to pick up your last task. No window opens either time.",
    },
    logPast: {
      title: "Log the meeting you forgot to time",
      body: "Open Raycast, press <strong>{shortcut}</strong>, and enter when the meeting started and ended. You don’t need to open the web app for it.",
    },
    offline: {
      title: "Works on a plane",
      body: "No Wi-Fi? Start and stop timers anyway. Raycast keeps the changes on your Mac and sends them when you’re online again.",
    },
    connect: {
      title: "Connect it in a minute",
      pairing:
        "The first time you open Track Your Time in Raycast, it shows a short code. Approve the code in your browser and you’re signed in. Reports and invoices stay in the web app, one command away.",
      selfHost:
        "Running your own server? Enter its address in the extension’s preferences. No rebuild needed.",
    },
  },

  mobile: {
    meta: {
      title: "iPhone and Android",
      description:
        "Track billable time on your iPhone or Android phone, even without signal. Everything syncs with your laptop.",
    },
    hero: {
      eyebrow: "Track Your Time for iPhone and Android",
      title: "Track time wherever the work happens",
      trackShotAlt: "The Track Your Time timer running on a phone",
      reportsShotAlt: "This week’s hours and earnings on a phone",
      menuShotAlt: "The Track Your Time menu on a phone, with timesheet, calendar and invoices",
      body: "Not every billable hour happens at a desk. Start a timer at a client’s office, on a site visit or on the train home. It’s waiting on your laptop when you sit down to write the invoice.",
    },
    offline: {
      title: "No signal? Keep tracking.",
      body: "The app works in airplane mode and in tunnels. Close it and the timer keeps running. When you’re back online, everything you did offline syncs by itself.",
    },
    wholeApp: {
      title: "The whole app, not a cut-down version",
      body: "Your timesheet, calendar, reports and invoices are all on your phone. Check this month’s hours before a client call, or fix yesterday’s entries on the way to work.",
    },
    lost: {
      title: "Lost your phone?",
      body: "Open Settings in the web app and sign the phone out. It loses access to your account right away.",
    },
    selfHost: {
      title: "Using your own server?",
      body: "The apps connect to trackyourtime.dev until you pick another server. On the sign-in screen, choose Change server and enter your server’s address.",
    },
  },

  /** The newsletter pages under /sub. App-style: they follow the reader's language at runtime. */
  newsletter: {
    subscribe: {
      metaTitle: "Subscribe",
      metaDescription: "Sign up for the newsletter.",
      title: "Subscribe",
      intro:
        "Drop your email below. We will send a confirmation link to verify the address — no list membership is created until you click it.",
    },
    form: {
      emailLabel: "Email address",
      placeholder: "you@example.com",
      submit: "Subscribe",
      submitting: "Sending…",
      cadence: "One email at a regular cadence. Unsubscribe link in every issue.",
      invalidEmail: "That doesn't look like an email address.",
      rateLimited: "Too many requests. Please wait a minute.",
      sendFailed: "Could not send confirmation email. Please try again.",
      generic: "Something went wrong. Please try again.",
      network: "Network error. Please try again.",
      successTitle: "Check your inbox.",
      successBody:
        "Tap the confirmation link to finish. Spam folder is the usual suspect if it does not surface.",
      alreadyTitle: "You are already on the list.",
      alreadyBody: "That address is already a confirmed subscriber. Nothing to do.",
    },
    confirmed: {
      metaTitle: "Subscription confirmed",
      title: "You’re in.",
      confirmed: "Subscription confirmed.",
      cadence: "The next issue will arrive at the usual cadence. Unsubscribe link in every email.",
    },
    error: {
      metaTitle: "Subscription link problem",
      title: "Hmm.",
      tryAgain: "Try again",
      reasons: {
        missing: "The confirmation link was missing its token. Try subscribing again.",
        malformed: "The confirmation link is malformed. Try subscribing again.",
        badSignature: "The confirmation link is invalid. Try subscribing again.",
        expired: "This confirmation link has expired. Please resubscribe to get a fresh one.",
        listAddFailed: "Something went wrong on our end while adding you to the list. Please try again.",
        fallback: "We couldn't confirm your subscription. Please try again.",
      },
    },
    backToSite: "Back to the site",
  },
} as const;
