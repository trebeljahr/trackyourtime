# Store assets — review hub

Everything a store reviewer or a shopper sees, in one place, so it can be
reviewed here and changed before it ships. Images are the exact files uploaded
to each console. The **canonical copy** lives in the ricos.site vault
(`.../projects/tracktime/tracktime-app-store-copy.md`); the strings below are a
copy of what was actually submitted, for review beside the images. If you change
a string here, change it in the vault too — the vault is the source of truth.

Regenerate the images from real captures with `scripts/marketing/render-graphics.mjs`
(see the top of that file). Do not hand-edit the PNGs.

Last updated 2026-09-23.

## Files

| Folder | File | Size | Where it went |
| --- | --- | --- | --- |
| `app-store/` | `iphone-6.9-1-track.png` | 1320×2868 | ASC 6.9″ slot (uploaded, COMPLETE) |
| | `iphone-6.9-2-reports.png` | 1320×2868 | ASC 6.9″ slot |
| | `iphone-6.9-3-more.png` | 1320×2868 | ASC 6.9″ slot |
| | `iphone-6.9-4-invoice.png` | 1320×2868 | ASC 6.9″ slot |
| | `ipad-13-{1-track,2-reports,3-more,4-invoice}.png` | 2064×2752 | ASC 13″ slot |
| `google-play/` | `icon-512.png` | 512×512 | Play icon (uploaded) |
| | `feature-graphic-1024x500.png` | 1024×500 | Play feature graphic (uploaded) |
| | `phone-{1-track,2-reports,3-more,4-invoice}.png` | 1080×1920 | Play phone screenshots (uploaded) |
| `chrome/` | `promo-marquee-1400x560.png`, `promo-small-440x280.png` | — | Chrome Web Store promo tiles |
| | `screenshot-{1-timer,2-autocomplete,3-entries,4-web-app}.png` | 1280×800 | Chrome Web Store screenshots |
| | `store-listing.de.md` | — | Chrome listing, German |

Screenshot captions are burned into each image, not stored separately. The
iPhone and iPad sets share four captions: **Track time on the go, even offline**
· **See what your week earned** · **Every screen of the web app, one tap away**
· **Create invoices from your phone**.

## Store state (2026-09-23)

| Item | App Store (ASC 6814737131) | Google Play (4975592922038277338) |
| --- | --- | --- |
| Name | Track Your Time: Timer & Bills | Track Your Time |
| Listing text | done | done |
| Privacy policy URL | done | done |
| Screenshots | iPhone + iPad uploaded | icon + feature + phone uploaded |
| Content / age rating | 4+ | Everyone / PEGI 3 / USK all ages |
| Data collection | App Privacy set, **not published** | Data safety saved |
| Sign-in / app access | demo account entered | demo account entered |
| Target audience | — | 18 and over |
| Category / tags | Productivity / Business | Productivity + 3 tags |
| Price | Free | Free |
| **Left** | App Privacy → Publish; a signed build; Add for Review | a signed AAB; Send for review (check 12-tester rule) |

Reviewer demo account: `demo@trackyourtime.dev` on production (password in
`~/projects/trackyourtime/.demo-account.local`, not in git). Origins
`capacitor://localhost` and `https://localhost` are trusted on production
(verified: `/api/health` → `originTrusted: true`).

## Submitted copy

### Shared
- **Support URL** https://trackyourtime.dev/support/
- **Marketing URL** https://trackyourtime.dev/mobile/
- **Privacy policy** https://trackyourtime.dev/privacy/
- **Contact** ricotrebeljahr@gmail.com · **Copyright** 2026 Rico Trebeljahr
- **Price** Free. No in-app purchases. No ads.

### App Store
- **Name** (30) `Track Your Time: Timer & Bills`
- **Subtitle** (30) `Billable hours, with no signal`
- **Promotional text** (170) `Start a timer in a tunnel. The app keeps it on the phone and sends it to your account when the signal returns. Free while Track Your Time is in beta.`
- **Keywords** (100) `timesheet,billable,hours,freelance,invoice,timer,worklog,consultant,client,project,offline,report`
- **Description** — see `google-play` full description below (same body; App Store copy says "iOS Keychain", Play says "Android Keystore", and Play adds an "Android back button" paragraph). The submitted text drops the old "no team features yet" sentence (workspaces exist).

### Google Play
- **Name** (30) `Track Your Time`
- **Short description** (80) `Track billable hours by client, project and task. Works with no signal.`
- **Full description** (submitted):

```
Track Your Time records the hours you bill. Start a timer, file it under a client, a project and a task, and add tags. Get the hours back as a report or an invoice.

The app has the same screens as the Track Your Time web app: the timer, the weekly timesheet, the calendar, reports, invoices, and your clients, projects, tasks and tags.

ONE TASK NAME FOR EVERY PROJECT
In Track Your Time, a task does not live inside a project. "Design review" is one task, and you use it for every client. So a report can tell you how many hours of design review you did this year, across all your clients.

IT WORKS WITH NO SIGNAL
Starts, stops and edits made offline go into a queue in the app's own storage. When the connection returns, the app sends them in order. A timer you start in airplane mode is still running after you close and reopen the app.

YOUR HOURS STAY IN YOUR ACCOUNT
Each queued change records the account that made it. If another person signs in on the same phone, the app does not send your changes to their account.

A NEW RATE DOES NOT CHANGE OLD ENTRIES
Track Your Time copies the hourly rate onto each entry when you save it. Raise a rate in March, and your February hours keep the February rate. An invoice collects billable time that is not on an invoice yet, and gives it the next number for that year.

ONE ACCOUNT, EVERY DEVICE
Stop a timer on your phone, and it stops in the web app, the Chrome extension and the Raycast extension too. Your session token is kept in the Android Keystore. Settings > Devices signs out any device, and its live connection closes within a minute.

ANDROID BACK BUTTON
Back closes the open dialog first. Then it goes to the timer. On the timer, it leaves the app.

OPEN SOURCE
Track Your Time is open source under AGPL-3.0. You can read the code at github.com/trebeljahr/trackyourtime, and run the server yourself.

Free while Track Your Time is in beta.
```

### Data declarations (both stores)
Collected, linked to the account, for app functionality only, no tracking:
Name, Email address, User IDs, and user content (entries, clients, projects,
tasks, tags, invoices). Plus **Crash logs** — the apps report crashes to a
self-run GlitchTip when `NEXT_PUBLIC_SENTRY_DSN` is set at build time. Nothing
is shared with third parties. Encrypted in transit. Deletion in-app
(Settings > Account > Delete account) and on the web.
