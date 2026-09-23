/**
 * English `marketing` messages — the SOURCE catalog for the public pages (landing, privacy, support, extension, raycast, mobile, download) and their metadata. Rendered at BUILD time in both locales — see i18n/marketing.ts.
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
      desktop: "Desktop",
      docs: "Docs",
    },
    logIn: "Log in",
    createAccount: "Create an account",
    openApp: "Open the app",
    footer: {
      tagline: "Free, open-source time tracking on every device.",
      chromeExtension: "Chrome extension",
      raycastExtension: "Raycast extension",
      mobile: "iPhone and Android",
      desktop: "Desktop app",
      invoiceGenerator: "Invoice generator",
      sourceCode: "Source code",
      docs: "Documentation",
      apiDocs: "REST API",
      privacy: "Privacy policy",
      support: "Support",
      press: "Press kit",
    },
  },

  /** Store buttons. `pending` is shown instead of a button while a listing is not live. */
  stores: {
    chrome: { pending: "Not in the Chrome Web Store yet", label: "Add to Chrome" },
    firefox: { pending: "Not on Firefox Add-ons yet", label: "Add to Firefox" },
    raycast: { pending: "Not in the Raycast Store yet", label: "Install from the Raycast Store" },
    appStore: { pending: "Not on the App Store yet", label: "Download on the App Store" },
    googlePlay: { pending: "Not on Google Play yet", label: "Get it on Google Play" },
  },

  landing: {
    meta: {
      title: "Track Your Time — free, open-source time tracking on every device",
      description:
        "Start a timer in your browser, your Mac’s menu bar or on your phone, even offline. Turn the hours into reports and invoices. Free, open source, and yours to host.",
    },
    hero: {
      eyebrow: "For freelancers and small teams who bill by the hour",
      title: "Open-source time tracking on every device you use",
      hostYourself: "Host it yourself",
      useHosted: "Use the hosted version",
      shotAlt: "The Track Your Time timer running, above a list of today’s billable entries",
      body: "Start a timer in your browser, from your Mac’s menu bar or on your phone. It keeps counting without a connection, and your other devices show the same timer. At the end of the month, the hours become a report or an invoice.",
      free: "Free for everyone, with no paid plan now or later. Use the hosted version, or run it on your own server.",
    },
    everywhere: {
      title: "Start the timer where the work starts",
      shotAlt: "The Track Your Time Chrome extension with a timer running",
      forgotten:
        "The hours you forget to track are the hours you don’t bill. So Track Your Time sits where you already are: a click in Chrome, a hotkey on your Mac, a tap on your phone.",
      offline:
        "On a train or a plane, keep tracking. Each app keeps your changes and sends them when the connection comes back. Stop a timer on your phone, and your laptop shows it stopped.",
    },
    surfaces: {
      web: { name: "Web app", text: "Timer, timesheet, calendar, reports, invoices and your team." },
      chrome: { name: "Chrome", text: "A timer in your toolbar. One click to start or stop." },
      raycast: { name: "Raycast", text: "A menu bar clock and a start/stop hotkey on your Mac." },
      mobile: { name: "iPhone and Android", text: "Track time away from your desk, even without signal." },
    },
    routine: {
      title: "Fewer clicks, fewer forgotten timers",
      repeat:
        "Most of today’s work is work you did yesterday. Start it again from your recent entries, or pin the jobs you do every day. Type the first letters of a description, and Track Your Time offers the client, project and tags you used with it last time.",
      guard:
        "Left a timer running overnight? Set a maximum length, and a timer that runs past it is stopped, or waits for your answer with an email reminder. Step away from your computer, and Track Your Time asks what to do with the time you were away.",
      suggestions:
        "Forgot the timer completely? Turn on activity capture in the Chrome extension. It notes which website had your attention and suggests entries for the gaps in your day. Nothing leaves your computer until you accept one.",
    },
    reports: {
      title: "See where the time went",
      shotAlt: "A report of four weeks of work, split by task, with hours and money earned",
      structure:
        "File each entry under a client and a project, name the task, and add tags. A task like “Design review” works across every project, so you can see what design reviews cost you this year.",
      hours:
        "Reports group the hours by client, project, task, tag, team member, day, week or month, and show what they earned. Give a project a budget in hours or money, and see how much of it is left.",
      edit: "Fix a day in the timesheet or drag entries on the calendar. Export any report as a CSV or a PDF when your accountant asks for it.",
    },
    invoice: {
      title: "From hours to invoice",
      shotAlt: "An invoice for one client, with a month of billable hours grouped into line items",
      rates:
        "Give each project an hourly rate. When it’s time to bill, pick a client and a month, and Track Your Time turns the unbilled hours into an invoice. Download it as a PDF, or as a ZUGFeRD or XRechnung e-invoice.",
      once: "An hour can’t be billed twice. And when you raise your rate, the hours you already worked keep the rate you agreed on.",
      generator: "No account yet? <tool>Make a single invoice in your browser</tool>. Nothing you type leaves the page.",
    },
    team: {
      title: "Track time as a team",
      invite:
        "Invite colleagues by email, or send them a link. Each person sees only their own time until you let them see colleagues’ hours or money. Reports then split the hours by person.",
      limits:
        "There’s no screenshot or keystroke monitoring. There’s also no timesheet approval yet, and everyone on a project bills at that project’s rate.",
    },
    data: {
      title: "Your data goes where you need it",
      import:
        "Coming from another time tracker? Export a CSV there and import it here. You see a preview before anything is saved, and you can undo the import.",
      export:
        "Take everything out as JSON or CSV at any time. To move a workspace from the hosted version to your own server, or back, use Settings → Data.",
      connect:
        "Connect your other tools through the <reference>REST API</reference>. It reads and writes entries, clients, projects, tasks and tags. Webhooks tell your tools when a timer starts or stops or an invoice changes. The <mcp>MCP server</mcp> lets an AI assistant start timers and log time for you.",
    },
    selfHost: {
      title: "Hosted or on your own server, it’s the same app",
      why: "A time tracker knows who your clients are, what you charge them and how you spend each working day. You choose where that lives: on trackyourtime.dev, or on a server you run yourself.",
      install:
        "Running your own takes one compose file. It starts the app, its database and HTTPS on a single server. A command-line tool creates accounts, resets passwords and checks the install. The <guide>self-hosting guide</guide> covers backups, upgrades and email, one step at a time.",
      clients:
        "Both run the same open-source code, with every feature. The Chrome extension, the Raycast extension and the phone apps work with either one. Each asks for a server address, so none of them needs rebuilding.",
      limits:
        "The first release isn’t published yet, so the first start builds from source and needs a server with 4 GB of memory. And the app can’t close sign-up yet: the guide shows how to block it at the proxy.",
    },
    free: {
      title: "Free, with nothing held back",
      license:
        "Track Your Time is open source under the AGPL-3.0. Every feature is in every install, the hosted version included. There’s no paid plan and no premium tier, and there won’t be one.",
      builtBy: "It’s built by one developer, Rico Trebeljahr, in the open on <repo>GitHub</repo>.",
      donate: "If it saves you a subscription, <donate>you can support development</donate>.",
    },
    faq: {
      title: "Questions",
      hosting: {
        q: "Do I have to host it myself?",
        a: "No. The hosted version at trackyourtime.dev is open to everyone and free. You can move to your own server later from Settings → Data, and back again.",
      },
      requirements: {
        q: "What do I need to run it?",
        a: "A Linux server with Docker, a domain name, and 4 GB of memory for the first build. The <guide>guide</guide> lists every command.",
      },
      clients: {
        q: "Can my clients follow their project’s progress?",
        a: "Not inside Track Your Time yet. There’s no client login and no shared link. Send them a report or an invoice as a PDF.",
      },
      stores: {
        q: "Where do I get the apps?",
        a: "The browser extension is in the Chrome Web Store, and Edge, Brave, Opera, Vivaldi and Arc install it from there. The Raycast extension and the phone apps aren’t in their stores yet. The web app works in any browser today, on your phone too.",
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
      noTracking: "The service never learns which websites you visit or what you do in other apps.",
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
        "The extension has no <strong>cookies</strong> permission and reads no cookies. When you are signed in at trackyourtime.dev, that page tells the extension through Chrome’s extension messaging. The extension then gets a session of its own from the server. You can sign it out in Settings → Devices.",
      idle: "The <strong>idle</strong> permission tells the extension that the computer is idle or locked. The extension uses it only to ask what to do with idle time. It does not send idle state anywhere.",
      server:
        "The extension sends your data to api.trackyourtime.dev. You can pick your own server in the popup instead, and your data then goes there. This policy does not cover that server.",
      tabs: "The optional <strong>tabs</strong> permission is for activity capture. Chrome asks for it only when you turn on Settings → Activity. It lets the extension read the address and title of the active tab. The extension never reads what is on a page, and it runs no code inside the pages you visit.",
      activity:
        "With activity capture on, the extension stores the site name of the active tab in the browser’s IndexedDB on your computer. It stores the page title only if you also switch on page titles. It deletes activity after 14 days, or after the period you set. It never records incognito tabs or the sites you exclude.",
      activityLocal:
        "The extension sends your activity nowhere. Only an entry you accept reaches the server, and that entry carries no site data.",
      limitedUse:
        "The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.",
    },
    raycast: {
      title: "The Raycast extension",
      body: "The Raycast extension stores your session token, a copy of recent data, and any unsent changes in Raycast’s encrypted local storage on your Mac. It talks only to the Track Your Time server set in its preferences.",
    },
    desktop: {
      title: "The desktop app",
      activity:
        "Activity capture is off until you turn it on in Settings → Desktop. With it on, the app stores the name of the app in front and when you used it. It keeps this in its own folder on your computer.",
      titles:
        "On Windows and Linux you can also switch on window titles. The Mac app does not record window titles.",
      retention:
        "The app deletes activity after 14 days, or after the period you set. It never records the apps you exclude, and excluding an app deletes what it already recorded for it.",
      local:
        "The app sends your activity nowhere. Only an entry you add reaches the server, and that entry holds only what you put in it.",
      stores: "The Mac App Store and Microsoft Store versions, Snap and Flatpak do not record activity.",
    },
    mobile: {
      title: "The iPhone and Android apps",
      keychain: "The apps keep your session token in the iOS Keychain or the Android Keystore.",
      storage:
        "Unsent changes and the running timer are stored in the app’s own storage on the phone, so that they survive a restart with no signal.",
      permissions:
        "The apps read the phone’s network state to know if they are online. They do not use your location, contacts, camera, microphone or photos.",
      noTracking:
        "The apps contain no advertising, analytics or tracking code. They send error reports as described below.",
    },
    errors: {
      title: "Error reports",
      when: "When the web app, the desktop app or a phone app hits an error it did not expect, it sends a report to the error tracker of Track Your Time. With no error, nothing is sent.",
      contains: {
        lead: "A report contains:",
        message: "the error message and where in the code it happened",
        page: "the page address, without anything after the question mark",
        requests: "the addresses, methods and status codes of the last requests the app made",
        version: "the app version",
        platform: "the platform: web, desktop, iPhone or Android",
        browser: "the names of the browser and the operating system",
      },
      omits: {
        lead: "A report never contains:",
        person: "your name or your email address",
        session: "your session token or cookies",
        input: "anything you typed",
        body: "the contents of any request",
        screen: "a recording of the screen",
      },
      ip: "Like every request to the service, a report arrives with your IP address. The report itself does not name it.",
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
          "Open the web app at trackyourtime.dev in the same Chrome profile, then open the popup again. The page tells the extension that you are signed in, and the extension signs in within a few seconds. This works only in that profile, and only when the extension uses trackyourtime.dev.",
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
    activity: {
      title: "Get back the hours you never timed",
      body: "Turn on activity capture, and the extension notes which website had your attention. Later it suggests entries for the stretches you didn’t track, and you accept, edit or dismiss each one.",
      privacy:
        "It records the site’s address, not what’s on the page. The records stay on your computer, and nothing reaches your account until you accept a suggestion.",
    },
    offline: {
      title: "Keeps tracking when the Wi-Fi doesn’t",
      body: "If the connection drops, keep working. The extension saves your changes and sends them as soon as you’re back online. Stop a timer here, and it’s stopped in the web app and on your phone too.",
    },
    login: {
      title: "No second login",
      body: "Logged in at trackyourtime.dev in Chrome? The extension logs in too. There’s no extra password and no API key to copy. Log out of the web app, and the extension logs out with it.",
    },
    browsers: {
      title: "Not using Chrome?",
      body: "Edge, Brave, Opera, Vivaldi and Arc install the extension from the Chrome Web Store. Your browser needs Chromium 116 or newer, and every current version of these browsers is newer than that.",
      edge: "Edge: open the extension in the Chrome Web Store and choose Allow extensions from other stores in the banner at the top. Then add the extension.",
      opera: "Opera: first add Install Chrome Extensions from Opera’s add-ons site. Then add the extension from the Chrome Web Store.",
      others: "Brave, Vivaldi and Arc: add it from the Chrome Web Store, the same way as in Chrome.",
      edgeStore: "The extension isn’t in Microsoft’s Edge Add-ons store. In Edge, use the copy from the Chrome Web Store.",
      same: "It works the same in each of these browsers, and it logs in with the web app there too.",
    },
    selfHost: {
      title: "Using your own server?",
      body: "The extension connects to trackyourtime.dev until you pick another server. Choose Change server below the sign-in form and enter your server’s address. Then sign in with your password, or approve the extension in your server’s web app. The <guide>self-hosting guide</guide> has the details.",
    },
    permissions: {
      title: "What the extension can access",
      login: "A login of its own, set up for you when you are logged in at trackyourtime.dev.",
      idle: "Whether your computer is idle, so it can ask what to do with the time you were away.",
      storage: "Storage on your computer, for changes made while you were offline.",
      server: "The Track Your Time server you sign in to.",
      tabs: "Which website is open in the current tab, only if you turn on activity capture.",
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
      body: "The apps connect to trackyourtime.dev until you pick another server. On the sign-in screen, choose Change server and enter your server’s address. The app checks that the server answers before it saves your choice.",
    },
  },

  /**
   * /download/: the desktop app. Only what the app does today, and a channel
   * is "not released yet" until `DESKTOP_DOWNLOADS` in lib/site-links.ts has
   * its address. Shortcuts are passed in, never written here.
   */
  download: {
    meta: {
      title: "Desktop app for macOS, Windows and Linux",
      description:
        "Start and stop your timer from the menu bar, the system tray or a keyboard shortcut in any app. Keeps tracking offline. Free and open source.",
    },
    hero: {
      eyebrow: "Track Your Time for macOS, Windows and Linux",
      title: "Start the timer from any app on your computer",
      body: "Press {mac} on a Mac, or {other} on Windows and Linux, and the timer starts or stops. You don’t switch windows, and you don’t keep a browser tab open for it.",
      downloads: "See the downloads",
      createAccount: "Create a free account",
    },
    tray: {
      title: "The running time in your menu bar",
      body: "On a Mac, the running time sits in the menu bar. On Windows and Linux, the tray icon changes while a timer runs. Open its menu to stop the timer, pick up one of your last five entries, or start a new one.",
      close: "Close the window on a Mac or on Windows, and Track Your Time keeps running in the background. Your timer and your changes keep syncing.",
    },
    away: {
      title: "It notices when you step away",
      body: "Turn on idle detection, and the desktop app notices when nobody uses your computer, whatever app you were in. When you come back, it asks what to do with the time you were away. If the window is hidden, a notification tells you.",
    },
    shortcuts: {
      title: "Shortcuts you choose",
      body: "Four actions can have a shortcut: start or stop the timer, start a new timer, show or hide the window, and open the command palette. Only the first one has a shortcut from the start. Change or clear any of them in Settings → Desktop. If another app already uses a shortcut, Settings tells you.",
    },
    offline: {
      title: "Keeps tracking when the connection drops",
      body: "Start and stop timers with no connection, from the menu, the shortcut or the window. The app keeps your changes on your computer and sends them when the connection comes back.",
      signIn: "Sign in with your password, or with your browser if your account uses two-factor authentication or Google. Using your own server? Choose it on the sign-in screen.",
    },
    channels: {
      title: "Downloads",
      notYet: "No version is released yet, so there’s nothing to download today. You can build the app from source. The <docs>desktop guide</docs> lists the steps.",
      intro: "Pick your system. The <docs>desktop guide</docs> explains how each version installs and updates.",
      mac: { name: "macOS (Apple silicon and Intel)", pending: "Not released yet", get: "Download from GitHub" },
      windows: { name: "Windows", pending: "Not released yet", get: "Download from GitHub" },
      linux: { name: "Linux (AppImage, deb or rpm)", pending: "Not released yet", get: "Download from GitHub" },
      homebrew: { name: "Homebrew", pending: "Not in Homebrew yet", get: "Install with Homebrew" },
      macAppStore: { name: "Mac App Store", pending: "Not in the Mac App Store yet", get: "Get it from the Mac App Store" },
      microsoftStore: { name: "Microsoft Store", pending: "Not in the Microsoft Store yet", get: "Get it from the Microsoft Store" },
      flathub: { name: "Flathub", pending: "Not on Flathub yet", get: "Get it on Flathub" },
      snapStore: { name: "Snap Store", pending: "Not in the Snap Store yet", get: "Get it from the Snap Store" },
    },
  },

  invoiceGenerator: {
    meta: {
      title: "Free invoice generator",
      description:
        "Make an invoice PDF in your browser. Your client, your rates and the totals stay on your computer. No account, no upload.",
    },
    hero: {
      eyebrow: "Track Your Time invoice generator",
      title: "Make an invoice without an account",
      body: "Fill in your details, your client and the work. Download a PDF you can send today.",
      privacy:
        "Everything you type stays in this browser. Nothing is sent to a server, and you need no account.",
    },
    form: {
      yourDetails: "Your details",
      billTo: "Bill to",
      invoice: "Invoice details",
      lines: "Lines",
      extras: "Notes",
      summary: "Summary",
      legalName: "Name or company",
      address: "Address",
      postalCode: "Postal code",
      city: "City",
      country: "Country",
      vatId: "VAT ID",
      taxNumber: "Tax number",
      email: "Email",
      phone: "Phone",
      paymentDetails: "Payment details",
      paymentTermsDays: "Payment terms (days)",
      logo: "Logo",
      logoUpload: "Upload logo",
      logoReplace: "Replace logo",
      logoRemove: "Remove",
      logoAlt: "Your logo",
      logoHint: "PNG or JPEG, up to {max} KB.",
      logoErrorFormat: "Choose a PNG or JPEG file.",
      logoErrorTooLarge: "The file is over {max} KB. Choose a smaller one.",
      logoErrorRead: "The file could not be read. Try another.",
      recipientName: "Client name",
      recipientLegalName: "Legal name",
      reference: "Reference",
      number: "Invoice number",
      currency: "Currency",
      issueDate: "Issue date",
      dueDate: "Due date",
      lineLabel: "Description",
      quantity: "Quantity",
      unit: "Unit",
      unitHour: "Hours",
      unitDay: "Days",
      unitPiece: "Pieces",
      unitPrice: "Unit price",
      taxCategory: "VAT category",
      taxCategories: {
        S: "Standard rate",
        Z: "Zero rated",
        E: "Small business (exempt)",
        AE: "Reverse charge",
        O: "Not subject to VAT",
      },
      vatRate: "VAT %",
      addLine: "Add line",
      removeLine: "Remove line",
      notes: "Notes",
      footer: "Footer",
      subtotal: "Subtotal",
      tax: "VAT",
      total: "Total",
      lineCount: "{count, plural, one {# line ready} other {# lines ready}}",
      download: "Download PDF",
      downloadError: "The PDF could not be made. Check the amounts and try again.",
      clear: "Clear",
      localOnly: "The PDF is made in your browser.",
    },
    privacy: {
      title: "Nothing leaves your browser",
      local: "You type into a page, and the page makes the PDF on your device. No server reads your client’s name, your rates or the total.",
      draft: "Your draft is saved in this browser so you can come back to it. Clear it any time with the Clear button. It is never sent anywhere.",
    },
    cta: {
      title: "Bill the hours you tracked",
      body: "Track Your Time records the hours you work, then turns them into an invoice like this one. Rates come from the project, and an hour on a sent invoice cannot be billed twice.",
      einvoice: "It also makes ZUGFeRD and XRechnung e-invoices — read the <docs>e-invoice guide</docs>.",
      signup: "Create an account",
    },
  },

  /** The newsletter pages under /sub. App-style: they follow the reader's language at runtime. */
  /**
   * /press/ — for somebody writing about Track Your Time. The boilerplate here
   * is the same text as the `## Boilerplate` section of the vault's
   * `trackyourtime-press-kit.md`, which is also what goes into the kit's
   * fact-sheet.txt. Change one and change the other.
   */
  press: {
    meta: {
      title: "Press kit — Track Your Time",
      description:
        "Screenshots, brand marks, a fact sheet and text you can quote, for anybody writing about Track Your Time. One download, no account.",
    },
    hero: {
      eyebrow: "For journalists, bloggers and reviewers",
      title: "Everything you need to write about Track Your Time",
      body: "One download holds the nine screenshots this site uses, the brand marks, the app icon and a one-page fact sheet.",
      quote: "Quote the text on this page as it is. Ask first only if you want to change it.",
      download: "Download the press kit",
      sourceCode: "Read the source code",
    },
    kit: {
      title: "What the download holds",
      screenshots: "Nine product screenshots as PNG files, at the sizes listed below.",
      brand: "Six brand marks as SVG files: the wordmark and five icon variants.",
      icons: "The app icon at 512×512, and the social card at 1200×630.",
      factSheet:
        "fact-sheet.txt — the licence, the price, every platform, and what the app does not do.",
    },
    boilerplate: {
      title: "Text you can quote",
      intro: "Three lengths.",
      oneLineLabel: "One line.",
      oneLine:
        "Track Your Time is free, open-source time tracking for people who bill by the hour, on the web, the phone, the desktop and the browser.",
      shortLabel: "Fifty words.",
      short:
        "Track Your Time is free, open-source time tracking for people who bill by the hour. Start a timer in the browser, on your phone or from the Mac menu bar. Each client works offline. The hours become a report, a PDF invoice or a German e-invoice. AGPL-3.0, and yours to host.",
      longLabel: "A hundred words.",
      long:
        "Track Your Time is free, open-source time tracking for people who bill by the hour. Start a timer in the web app, the Chrome extension, Raycast, or the iPhone and Android apps. Every client keeps counting without a connection. Stop a timer on your phone, and your laptop shows it stopped. At the end of the month the hours become a report, a PDF invoice, or a ZUGFeRD or XRechnung e-invoice. Invite colleagues, and each person sees only their own time until you allow more. There is no paid plan. Run the hosted version, or the same app on your own server.",
    },
    shots: {
      title: "Screenshots",
      intro: "Every file below is in the download, under marketing/, at the size given beside it.",
      webTrack: {
        label: "The timer",
        alt: "A timer running in the Track Your Time web app, above the entries logged today",
      },
      webTimesheet: {
        label: "The weekly timesheet",
        alt: "A week of tracked hours in a grid, with a total per day and per project",
      },
      webCalendar: {
        label: "The calendar",
        alt: "Tracked entries laid out across a week by the time of day they happened",
      },
      webReports: {
        label: "Reports",
        alt: "A report of the month's hours, grouped by client, with the amount each one earned",
      },
      webInvoice: {
        label: "An invoice",
        alt: "An invoice built from tracked hours, with one line per project and the total due",
      },
      phoneTrack: { label: "The timer on a phone", alt: "The Track Your Time timer running on a phone" },
      phoneReports: { label: "Reports on a phone", alt: "A week's tracked hours as a report on a phone" },
      phoneMore: { label: "The phone menu", alt: "The menu that opens every other screen on a phone" },
      popup: {
        label: "The browser extension",
        alt: "The Track Your Time browser extension popup with a timer running",
      },
    },
    facts: {
      title: "The facts, before you publish",
      price: {
        term: "Price",
        detail: "Free. There is no paid plan, now or later. No ads, and nothing to buy inside the app.",
      },
      licence: {
        term: "Licence",
        detail: "AGPL-3.0. Read the code, run it on your own server, and change it.",
      },
      platforms: {
        term: "Where it runs",
        detail:
          "The web app, iPhone, iPad, Android, macOS, Windows, Linux, Chrome, Firefox and Raycast. Only the web app and the Chrome extension are published. The rest build and run from source.",
      },
      status: {
        term: "Version",
        detail: "0.1.0. No release is tagged yet, so self-hosting builds the images from source.",
      },
      madeBy: { term: "Made by", detail: "Rico Trebeljahr, on his own." },
      source: { term: "Source code", detail: "github.com/trebeljahr/trackyourtime" },
    },
    contact: {
      title: "Ask a question",
      body: "Write to <mail>{email}</mail>. Say what you are writing and when you need an answer, and you will get one.",
    },
  },
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
