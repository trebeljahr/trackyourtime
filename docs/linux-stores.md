# Snap Store and Flathub

How Track Your Time reaches the two Linux stores. The build side is
`docs/deploy.md` → "Desktop release"; this file is everything after the build:
the account work only a person can do, the one CI secret, the Flathub pull
request, and what stays manual on purpose.

Nothing on Linux is signed. That is deliberate (`docs/deploy.md`), and both
stores sign what they distribute themselves.

## Before anything: there is no published release yet

Both stores need a `v*` GitHub release that is **published**, not a draft:

- Flathub's manifest downloads `TrackYourTime-<version>-linux-{x64,arm64}.tar.gz`
  from the release page, and its update bot reads
  `/releases/latest`, which only ever names a published, non-prerelease release.
- The Snap Store takes the `.snap` from CI rather than from the release page, so
  it does not strictly need one — but promotion to `stable` is tied to
  publishing, so that the two stores and the direct downloads never disagree
  about what the current version is.

State on 2026-09-27: the tag `v0.1.0` exists and the repository has **no
releases at all** — the tag's `desktop-release.yml` run failed, and the tag may
be recut. So every step below that names a file or a URL of a release is marked
**after publish**. Do not invent those URLs: they are derived from
`artifactPatterns` in `scripts/lib/desktop-release.mjs`, and
`scripts/desktop-manifests.mjs` fills them from the real files.

---

# Snap Store

## What is already built

`desktop-release.yml`'s `linux-x64` and `linux-arm64` legs each build a
`.snap` (`electron-builder.config.mjs` → `linux.target`), named
`trackyourtime_<version>_{amd64,arm64}.snap`. The snap is a CI artifact and is
**never attached to the GitHub release** — `releasePlan`'s `STORE_ONLY` pattern
excludes `.snap`, and a unit test pins that.

What the snap declares:

| | |
| --- | --- |
| Name | `trackyourtime` |
| Confinement | `strict` |
| Grade | `stable` |
| Plugs | the electron-builder defaults, plus `password-manager-service` |
| Open at login | works — snapd reads `$SNAP_USER_DATA/.config/autostart` (`snap.autoStart`, `loginItemMechanism`) |
| In-app updater | off. `selfUpdates` refuses the `snap` channel; the Store updates the app |
| Activity capture | **off, and cannot be turned on.** `activityCaptureSupport` answers `{ unsupported, "linux-sandbox" }` for `snap`, main forces `enabled` and `storeTitles` off, and the nav item is hidden. The listing must not offer it |

**The base is still `core20`.** `electron-builder.config.mjs` sets no
`snap.base`, so app-builder-lib (26.17.0 as of writing) takes its legacy
strategy and its bundled `templates/snap/snapcraft.yaml`, whose first line is
`base: core20`; the `core24` strategy is only reached by naming that base. A
separate task owns the `core20`-not-supported failure on arm64 — **this file
does not change the base**, and the publish step below works whatever base that
task settles on.

## What Rico must click, once

1. **Ubuntu One account.** Open <https://snapcraft.io/> → *Sign in* → *I don't
   have an Ubuntu One account*. One email, one password. Nothing else is needed;
   there is no fee and no identity check.
2. **Accept the developer terms.** The first visit to
   <https://snapcraft.io/account> asks for a developer name and shows the
   Snap Store Terms of Service. Accept them there. (An agent must not accept
   terms; this step is Rico's.)
3. **Register the name.** Either
   <https://snapcraft.io/register-snap> with `trackyourtime` in the field, or,
   from a machine with snapcraft installed:

   ```bash
   snapcraft login
   snapcraft register trackyourtime
   ```

   The name is unclaimed as of writing; check with
   `snap info trackyourtime` or <https://snapcraft.io/trackyourtime>. A
   registered name is held for you and is **permanent in practice** — snapd
   keys `/snap/trackyourtime`, `$SNAP_USER_DATA` and `/snap/bin/trackyourtime`
   on it, and `loginItemMechanism` writes `/snap/bin/trackyourtime` into the
   autostart entry. Renaming it would orphan every install's session and
   offline queue, exactly as with the other identifiers CLAUDE.md lists.

4. **Export a CI credential and set the secret.** On the same machine:

   ```bash
   snapcraft export-login \
     --snaps trackyourtime \
     --channels candidate,beta \
     --acls package_access,package_push,package_update,package_release \
     --expires 2027-09-27 \
     snapcraft-credentials.txt

   gh secret set SNAPCRAFT_STORE_CREDENTIALS < snapcraft-credentials.txt
   rm snapcraft-credentials.txt
   ```

   The ACLs are the narrowest set that can upload and release. `--channels
   candidate,beta` is what CI uses, so a leaked credential cannot push to
   `stable`; promotion is then done from Rico's own login. `--expires` is not
   optional in practice — an open-ended store credential is one nobody ever
   rotates. Note the date in `docs/release-credentials.md` when you set it.

## What CI then does, and what it does not

`desktop-release.yml`'s Linux legs run `scripts/snap-publish.mjs` after the
build. The decision is `snapPublishPlan` in `scripts/lib/desktop-release.mjs`,
unit-tested, and it follows the all-or-none rule of every other channel — with
one credential, "none" is simply "not set":

| Situation | What happens |
| --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` not set | a `::notice::`, leg stays green, the snap stays a CI artifact |
| Not a tag (dispatch, branch) | a notice; nothing is uploaded |
| Tag, credential set | `snapcraft upload --release candidate` for that leg's one snap |
| Prerelease tag (`v1.2.0-rc.1`) | the same, to `beta` — the rule that keeps `mobile-release.yml` on Play's internal track |
| Tag does not match `package.json` | an `::error::` and the leg fails |
| More than one `.snap` in `release/` | an `::error::`. Uploading the wrong architecture to a channel cannot be taken back |
| `snapcraft upload` fails | the leg fails. Snap Store review runs on upload, and a refusal must not pass quietly |

**CI never releases to `stable`.** A tag builds a *draft* GitHub release and a
person publishes it; publishing is the release decision, and a `stable` upload
would hand the app to every install before that decision was made.

## Promote the snap

**After publish**, from a machine with `snapcraft login` done:

```bash
snapcraft status trackyourtime                        # which revision is where
snapcraft release trackyourtime <revision> stable     # one per architecture
```

`snapcraft status` lists a revision per architecture; both need releasing.
There is no rollback that removes a bad revision from people who already have
it — `snapcraft release` an older revision back onto `stable`, or fix forward,
the same rule as the staged rollout.

## The listing

The Store's listing page (<https://snapcraft.io/trackyourtime/listing>) is
filled from the snap's own metadata on first upload and can be overridden
there. Two fields come from the build and should not be retyped:

- **Title** `Track Your Time` (`snap.title`, from `productName`)
- **Summary** `Free, open-source time tracking` (`snap.summary`)

The snap's `description` is deliberately one line
(`Free, open-source time tracking for people who bill by the hour.`), because
electron-builder writes the description into the desktop entry's `Comment=` as
well, where a newline becomes a literal `\n` — a paragraph there reads as one
run-on tooltip. So paste the full description into the listing page by hand.
This is the text — every claim in it is true of this snap today:

```markdown
Track Your Time is free, open-source time tracking for people who bill by the hour.

Start a timer from the window or the tray, and file it under a client, a project and a task. The timer keeps counting without a connection, and sends your changes when the connection comes back. Stop it on your phone or in the browser, and this window shows it stopped.

A task is not a child of a project. "Design review" is one name you use for every client, so a report can tell you how many hours of it you did this year.

The hourly rate is copied onto each entry when you save it. Raise a rate in March, and your February hours keep the February rate.

At the end of the month the hours become a report, a PDF invoice, or a German ZUGFeRD or XRechnung e-invoice.

There is no paid plan. Use the hosted service at trackyourtime.dev, or point the app at your own server.

## After you install

Run this once, so the app can keep your session in the desktop keyring:

    snap connect trackyourtime:password-manager-service

Without it the app holds the session in memory, and asks you to sign in again after every restart. Settings > Devices says which of the two applies.

## What this snap does not do

The Snap Store updates the app, so it carries no updater of its own. It does not record which application is in front: that feature is off inside snap confinement.
```

The rest of the listing page:

| Field | Value |
| --- | --- |
| Category | Productivity |
| Licence | `AGPL-3.0-or-later` |
| Contact | <https://trackyourtime.dev/support/> |
| Website | <https://trackyourtime.dev/> |
| Source code | <https://github.com/trebeljahr/trackyourtime> |
| Screenshots | the four 1600×1000 captures in `packages/client/public/marketing/` (`web-track`, `web-timesheet`, `web-reports`, `web-invoice`) |

**Ask for auto-connection of the plug.** `password-manager-service` is not
auto-connected, so every user runs `snap connect` by hand. The way out is a
request on the Snapcraft forum (<https://forum.snapcraft.io/>, category *store
requests*) asking for auto-connect on `trackyourtime`, with the reason: the
app's session token is kept in the desktop keyring through Electron's
`safeStorage` (`electron/src/secure-store.ts`), and without the Secret Service
it is held in memory and the person is signed out on every restart. Until it is
granted, keep the `snap connect` line in the listing.

---

# Flathub

## The app id is `com.ricoslabs.trackyourtime`, unchanged

Flathub requires a reverse-DNS id whose domain "must be directly related to the
project … and the author or the developer or the project must have control over
the domain", reachable over HTTPS
(<https://docs.flathub.org/docs/for-app-authors/requirements>).

`com.ricoslabs.trackyourtime` reads as `ricoslabs.com`, which Rico owns (it is
the Ricos Labs domain, already the Firefox add-on id's, on the same Cloudflare
account as `trackyourtime.dev`) and which answers `200` over HTTPS. A vendor
domain rather than the product's own is normal on Flathub —
`com.system76.*`, `com.valvesoftware.*` — and the id satisfies every other
rule: three components, no `.desktop`/`.app`/`.linux` suffix, lowercase.

`dev.trackyourtime.TrackYourTime` would also be valid, and is **not** used: the
bundle id is a contract (CLAUDE.md → "Product name"), the Flatpak id keys
`~/.var/app/<id>` and every `--talk-name` permission, and one id across macOS,
Windows, the App Store, Play and Flathub is worth more than a prettier string.

**The verification badge needs `ricoslabs.com`, not `trebeljahr.com`.** Flathub
verification by website reads
`https://ricoslabs.com/.well-known/org.flathub.VerifiedApps.txt` and looks for
the app's token, one per line, `#` for comments
(<https://docs.flathub.org/docs/for-app-authors/verification>). The token comes
from the Flathub developer portal after the app exists, so this is a step for
**after the first Flathub build**, and it needs a file added to the
`ricoslabs.com` site.

## What this repository already produces

`node scripts/desktop-manifests.mjs --artifacts <dir> --out <dir> --only flatpak`
renders, from `packaging/flatpak/`:

| File | What it is |
| --- | --- |
| `com.ricoslabs.trackyourtime.yml` | the Flathub manifest: the two release tarballs per architecture, the zypak launcher, the icon and the licence, each with a real sha256 |
| `com.ricoslabs.trackyourtime.metainfo.xml` | the AppStream metadata: name, summary, description, four screenshots, URLs, branding, content rating, the release entry |
| `com.ricoslabs.trackyourtime.desktop` | the desktop entry, with `StartupWMClass=Track Your Time` — what electron-builder writes for the deb, rpm, AppImage and snap |

Three things in there are load-bearing:

- **The metainfo promises nothing the Flatpak refuses.** No in-app updater, no
  "open at login", no activity capture — `selfUpdates`, `loginItemMechanism`
  and `activityCaptureSupport` in `electron/src/distribution.ts` all refuse the
  `flatpak` channel. A unit test greps the template for that wording.
- **The screenshots are unversioned URLs** on `https://trackyourtime.dev/marketing/`,
  the committed captures the site serves (`docs/marketing/README.md`). Flathub
  downloads them when it builds, and its update bot rewrites the manifest's
  source URLs but never a screenshot URL — a `{{version}}` in one would go
  stale on the next release. The unit test refuses one.
- **Every source carries `x-checker-data`,** so after the first submission
  Flathub's `flatpak-external-data-checker` opens its own pull requests against
  the app's repository when a new release is published. The jq queries were run
  against a real `releases/latest` payload; `-linux-x64` does not match the
  arm64 asset.

## Prebuilt tarball, and why that is the plan

The manifest repackages the release tarball instead of building the app inside
flatpak-builder. Flathub's requirements page says "All source available
submissions must be built entirely from source code", and its moderators, asked
directly, say the rule is about the pull request's contents: "you are free to
build from binary packages in the Flatpak manifest"
(<https://discourse.flathub.org/t/best-way-to-submit-new-app-sources-or-binary/8668>).
The precedent is `com.vscodium.codium` — open source, Electron — which is on
Flathub today unpacking its own release `.deb` per architecture, with the same
`x-checker-data` shape used here.

A reviewer may still ask for a source build. That build needs every npm
dependency vendored with `flatpak-node-generator`, which this repo has not run,
and it would also have to reproduce the Next.js static export offline. If it is
asked for, it is a separate task, not a change to make pre-emptively.

## Submitting, step by step

**After publish**, and after `pnpm release:status` says the release is published:

1. Render the manifests from the real release files — Actions → **Desktop
   Manifests** → *Use workflow from* → the `v<version>` tag. (Locally:
   `gh release download v<version> -D rel && node scripts/desktop-manifests.mjs
   --artifacts rel --out manifests --only flatpak`.)
2. Fork <https://github.com/flathub/flathub> and branch **from `new-pr`**:

   ```bash
   git checkout -b add-com.ricoslabs.trackyourtime new-pr
   ```

   A pull request against `master` is closed unread.
3. Commit exactly the three rendered files at the repository root. Nothing
   else: Flathub refuses a submission that carries a binary or a build
   artifact.
4. Open the pull request against the **`new-pr`** base branch, titled
   `Add com.ricoslabs.trackyourtime`. Reviewers run the build; a bot comments
   with the log and an installable test build.
5. On merge, Flathub creates `flathub/com.ricoslabs.trackyourtime` and invites
   you to it. GitHub 2FA is required, and the invitation expires in a week.
   Every later release is a commit there — by the checker bot, or by hand from
   step 1's output.
6. **After the first build:** claim the app in the Flathub developer portal,
   put its token in
   `https://ricoslabs.com/.well-known/org.flathub.VerifiedApps.txt`, and
   verify. Then set `DESKTOP_DOWNLOADS.flathub` in
   `packages/client/src/lib/site-links.ts` to the listing URL.

## What is still manual, on purpose

| Step | Why it is not automated |
| --- | --- |
| Publishing the draft GitHub release | it is the release decision; electron-updater reads only published releases |
| `snapcraft release … stable` | the same decision, for the Snap Store |
| The Snap Store listing text and screenshots | one-time, and an agent must not accept the Store terms that gate the page |
| The Snapcraft forum request for `password-manager-service` | a human request in a public forum thread |
| The Flathub pull request | a fork, a PR to another organisation's repository, and an invitation to accept |
| The `.well-known` verification file | it is a change to the `ricoslabs.com` site, not to this repo |
| `DESKTOP_DOWNLOADS` entries | `null` until a listing exists; `/download` says "not released yet" until then |

## Secret and credential summary

| Name | Kind | Used by | Value |
| --- | --- | --- | --- |
| `SNAPCRAFT_STORE_CREDENTIALS` | GitHub secret | `desktop-release.yml`, Linux legs | the output of `snapcraft export-login` (above). Unset means the snap is only a CI artifact |

Flathub needs no secret in this repository: it builds in its own
infrastructure from the manifest.
