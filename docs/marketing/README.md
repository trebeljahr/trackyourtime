# Marketing assets — review hub

Every image and every string a store reviewer or a shopper sees, indexed here so
it can be checked in one place. The images under `docs/marketing/` are the exact
files uploaded to each console. The **canonical copy** lives in the ricos.site
vault (`.../projects/tracktime/tracktime-app-store-copy.md` and
`.../projects/tracktime/trackyourtime-press-kit.md`); the strings below are a
copy of what was actually submitted, kept here for review beside the images. If
you change a string here, change it in the vault too — the vault is the source
of truth.

Regenerate the store images from real captures with
`scripts/marketing/render-graphics.mjs` (see the top of that file). Do not
hand-edit the PNGs.

Last updated 2026-09-23.

## Where each asset lives, and why

Only the three folders under `docs/marketing/` can move. They hold what somebody
uploads by hand to a console, and nothing reads them at runtime. Everything else
listed here ships inside a build, at a path that code or a store already names:

| Folder | What it holds | Can it move? |
| --- | --- | --- |
| `docs/marketing/app-store/` | App Store Connect screenshots | yes — uploaded by hand |
| `docs/marketing/google-play/` | Play icon, feature graphic, screenshots | yes — uploaded by hand |
| `docs/marketing/chrome/` | Chrome Web Store tiles, screenshots, German listing | yes — uploaded by hand |
| `packages/client/public/marketing/` | product screenshots the live web pages serve | **no** — the pages load them by path |
| `packages/client/public/brand/` | the brand SVG marks | **no** — `pnpm icons:brand` derives every shipped bitmap from them, and `render-graphics.mjs` reads `mark-tile.svg` |
| `packages/raycast/metadata/` | Raycast store screenshots | **no** — `ray build` and store review read that exact path |
| `packages/raycast/assets/` | the Raycast extension's runtime icons | **no** — `package.json` names them |
| `packages/client/public/press-kit.zip` | the kit `/press/` links to | **no** — the page links that address |

## Files

### `docs/marketing/app-store/` — uploaded, complete

| File | Size | Where it went |
| --- | --- | --- |
| `iphone-6.9-{1-track,2-reports,3-more,4-invoice}.png` | 1320×2868 | ASC 6.9″ slot (uploaded, COMPLETE) |
| `ipad-13-{1-track,2-reports,3-more,4-invoice}.png` | 2064×2752 | ASC 13″ slot (uploaded, COMPLETE) |

All eight are in App Store Connect app **6814737131**.

### `docs/marketing/google-play/` — uploaded

| File | Size | Where it went |
| --- | --- | --- |
| `icon-512.png` | 512×512 | Play icon |
| `feature-graphic-1024x500.png` | 1024×500 | Play feature graphic |
| `phone-{1-track,2-reports,3-more,4-invoice}.png` | 1080×1920 | Play phone screenshots |

All six are in Play app **4975592922038277338**.

### `docs/marketing/chrome/`

| File | Size | Where it went |
| --- | --- | --- |
| `promo-marquee-1400x560.png` | 1400×560 | Chrome Web Store marquee tile |
| `promo-small-440x280.png` | 440×280 | Chrome Web Store small tile |
| `screenshot-{1-timer,2-autocomplete,3-entries,4-web-app}.png` | 1280×800 | Chrome Web Store screenshots |
| `store-listing.de.md` | — | the German listing text |

### `packages/client/public/marketing/` — served at runtime, cannot move

The marketing pages and the press page load these by path, so a rename breaks a
live page. They are also what `scripts/marketing/build-press-kit-zip.mjs`
bundles into `press-kit.zip`.

| File | Size | Shown on |
| --- | --- | --- |
| `web-track.png` | 1600×1000 | landing, press |
| `web-timesheet.png` | 1600×1000 | landing, press |
| `web-calendar.png` | 1600×1000 | landing, press |
| `web-reports.png` | 1600×1000 | landing, press |
| `web-invoice.png` | 1600×1000 | landing, press |
| `phone-track.png` | 645×1436 | `/mobile/`, press |
| `phone-reports.png` | 645×1436 | `/mobile/`, press |
| `phone-more.png` | 645×1436 | `/mobile/`, press |
| `popup.png` | 760×1200 | `/extension/`, press |

### `packages/client/public/brand/` — the source of every shipped bitmap, cannot move

SVG only. `pnpm icons:brand` derives `build/icon.png`, the web manifest icons,
the tray icons and the native app icons from these; `pnpm icons:desktop` fans
`build/icon.png` out to icns and ico. Do not hand-edit anything downstream of
them.

| File | Used for |
| --- | --- |
| `logo-lockup.svg` | the wordmark — site header, press kit |
| `mark-tile.svg` | the square mark — app icons, store graphics, `render-graphics.mjs` |
| `mark-maskable.svg` | the PWA maskable icon |
| `mark-adaptive-foreground.svg` | the Android adaptive icon foreground |
| `mark-bar-clock.svg` | the menu bar and tray mark |
| `mark-timer-arc.svg` | the running-timer mark |

### `packages/client/public/press-kit.zip` — the public download, cannot move

The kit `/press/` links to: the nine screenshots above under `marketing/`, the
six brand marks under `brand/`, `icon-512.png`, `og.png` and `fact-sheet.txt`.

`scripts/marketing/build-press-kit-zip.mjs` writes it (`pnpm
marketing:press-kit-zip`), deterministically, so rebuilding it after no change
leaves an empty diff. It is **committed** although it is a build artifact:
neither `pnpm build:web` nor `packages/client/Dockerfile` runs the builder, so
an uncommitted zip is a 404 on the deployed site. Rebuild it after changing
anything under `public/marketing/`, `public/brand/`, `build/icon.png`,
`public/og.png`, or the vault press-kit note its fact sheet is read from
(`.../projects/tracktime/trackyourtime-press-kit.md`).

### `packages/raycast/metadata/` — not captured yet

| File | Size | State |
| --- | --- | --- |
| `trackyourtime-1.png` … `trackyourtime-6.png` | 2000×1250 | **not captured yet** — the folder does not exist |

Up to six PNGs, all exactly 2000×1250, nothing else in the folder, every shot
from seeded demo data. `ray lint` does not require them, but store review
expects screenshots from an extension with view commands. The shot list, the
Window Capture setup and the size check are in
`packages/raycast/PUBLISHING.md` → "Store screenshots".

Deliberately still open, and not a task an agent can pick up unattended. Raycast
is a launcher: its window only accepts input in the foreground, so capturing
these takes over the screen for several minutes. It also changes the machine —
`pnpm dev:raycast` replaces whatever development copy of the extension Raycast
already holds, including its stored session and preferences, and the recipe
needs a Window Capture hotkey and "Save to Metadata" switched on in Raycast
Settings. They are only needed before the first Raycast Store publish, which is
not queued. Do them at the desk, seeding the demo data immediately beforehand —
the running timer and today's entries are relative to the moment of seeding.

### `packages/raycast/assets/` — extension runtime, not store material

| File | Size | Used for |
| --- | --- | --- |
| `icon.png` | 512×512 | the extension icon Raycast shows in its list |
| `menu-bar.png` | 64×64 | the menu bar command's item |

## Captions

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
| Data collection | App Privacy **published** 2026-09-23 | Data safety saved |
| Sign-in / app access | demo account entered | demo account entered |
| Target audience | — | 18 and over |
| Category / tags | Productivity / Business | Productivity + 3 tags |
| Price | Free | Free |
| **Left** | a signed build; Add for Review | a signed AAB; Send for review (check 12-tester rule) |

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
