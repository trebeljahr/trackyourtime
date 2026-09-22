# Releasing

A release is a `vX.Y.Z` git tag; `pnpm release X.Y.Z` cuts one ([Steps](#steps)). Pushing it runs
`.github/workflows/release.yml`, which publishes two images for self-hosters:

- `ghcr.io/trebeljahr/trackyourtime-server`
- `ghcr.io/trebeljahr/trackyourtime-client-selfhost`

Both are built for `linux/amd64` and `linux/arm64`. Nothing is deployed. The hosted instance still deploys from
`build-and-deploy.yml` on every push to `main`.

The same tag also runs `.github/workflows/extension-release.yml`, which builds
the browser extension and, once its secrets exist, submits it to the Chrome
Web Store. Without the secrets it only uploads the zip as an artifact. See
[Chrome Web Store](#chrome-web-store).

A tag also runs `desktop-release.yml`, which builds every desktop channel and
uploads the signed downloads and their update feeds to a **draft** GitHub
Release (docs/deploy.md → "Desktop release"). Publishing that draft is the
desktop release: installed apps only see published releases, and they update
from the next one they see.

`mobile-release.yml` runs on manual dispatch only.

## What the workflow does

| Job | Result |
|---|---|
| `prepare` | Resolves the version, the commit, and whether `X.Y` and `latest` may move. Fails a tag whose version bump understates its API or schema changes (see [Checklist](#checklist)). |
| `release-server`, `release-client-selfhost` | Build each image on a native amd64 and a native arm64 runner and push them by digest, with no tag. |
| `merge` | Joins the two digests into one multi-arch image and pushes the exact tag, `vX.Y.Z`. |
| `smoke` | On amd64 and arm64, with no registry login: pulls `vX.Y.Z`, starts `docker-compose.selfhost.yml` from the tagged commit, and checks `/api/health`, `/` and `/api/auth/get-session`. |
| `promote` | Points `X.Y` and `latest` at `vX.Y.Z`. Runs only when `smoke` passed on both arches. |

Tag rules:

- `vX.Y.Z` is always published.
- `X.Y` moves only when this is the newest stable release in that series.
- `latest` moves only when this is the newest stable release overall.
- A prerelease such as `v0.2.0-rc.1` gets its exact tag and nothing else.

The server image reports its commit in `/api/health` as `commit`, and as
`version` for older readers.

## Checklist

`prepare` runs `scripts/release-policy-check.mjs` and fails the tag, before
anything is built, when one of the checked items is wrong. Go through the list
before tagging:

- [ ] **The number matches the changes** (`docs/versioning.md` → Release
  numbers). Patch: no `API_LEVEL` change and no new migration. Minor: a new
  API level or migrations older releases can read. Major (minor while the major
  is 0): a raised `MIN_CLIENT_API_LEVEL` / `MIN_SERVER_API_LEVEL`, or a
  migration with a `minReaderSchema` above the previous release's schema.
  *Checked.*
- [ ] **Every new API level has an `API_LEVEL_CHANGES` row**, and its `release`
  is this version, e.g. `"0.2.0"`. *Checked.*
- [ ] **The API contract snapshot is current.** `pnpm test:unit` passes on the
  tagged commit.
- [ ] **The release notes exist** at `docs/release-notes/vX.Y.Z.md`. *Checked.*
  When the release adds migrations they say so, and what each one does.
  *Checked.* When a migration raises `minReaderSchema` they also contain the
  sentence "Rollback requires restoring your dump." *Checked.*
- [ ] **`CHANGELOG.md` has a dated `## [X.Y.Z]` section.** *Checked.*
- [ ] **`compat.yml` is green on `main`**: the current clients against the
  previous release's server, and the reverse.

Prereleases (`vX.Y.Z-rc.N`) are checked for the bump and the API-level rows
only.

## Steps

`pnpm release X.Y.Z` does steps 1 and 2 below on your machine and pushes
nothing. The manual steps stay documented as what the script does, and each
of them still works by hand.

1. **Write the record on `main`.** The script needs two things it cannot
   write for you:

   - In `CHANGELOG.md`, rewrite the opening paragraph of `## [Unreleased]` in
     the past tense. The script renames the heading and moves the body as it
     is.
   - `docs/release-notes/vX.Y.Z.md`, the body of the GitHub release page.
     Without it, `pnpm release` writes a draft from the changelog section and
     stops, so you can rewrite it for someone deciding whether to upgrade.
     Commit it and run the command again. `--yes` releases with the draft as
     it is.

   If the release added a tRPC procedure, input field, enum value or sync
   event kind, `API_LEVEL` must already be bumped and its
   `API_LEVEL_CHANGES` row must name this version (`docs/versioning.md`).
   The policy check refuses otherwise.

2. **Cut the release.**

   ```bash
   pnpm release 0.1.0 --dry-run   # prints the diff and the checks, writes nothing
   pnpm release 0.1.0
   ```

   The script refuses a working tree that is not clean, a branch other than
   `main`, a `main` behind `origin/main`, tags on `origin` that this checkout
   lacks, a version that is not higher than the root `package.json` (the
   current version is allowed while no tag has it: that is the first
   release), and an existing tag. Then, in this order:

   1. Sets `"version"` in the root `package.json` to `X.Y.Z`. It is the one
      version number. `/version.json`, the web bundle and the browser
      extension's manifest read it. Sets every hand-kept copy to the same
      value: each workspace `package.json` that has a version, the Raycast
      `APP_VERSION` and the MCP `SERVER_VERSION`, the `TRACKYOURTIME_VERSION`
      defaults in `.env.selfhost.example` and `docker-compose.selfhost.yml`
      (the copies `scripts/lib/version-sync.test.mjs` checks, so
      `pnpm run test:unit` fails until they match), the iOS
      `MARKETING_VERSION` and the Android `versionName` (which
      `pnpm build:mobile` checks). It raises the iOS
      `CURRENT_PROJECT_VERSION` and the Android `versionCode` by one, since
      App Store Connect and Play each refuse a build number they have seen.
      Releasing the version the tree already carries leaves both build
      numbers alone.
   2. In `CHANGELOG.md`, renames `## [Unreleased]` to
      `## [X.Y.Z] - <today>`, adds an empty `## [Unreleased]` above it,
      points the `[Unreleased]` link at `compare/vX.Y.Z...HEAD` and adds a
      `[X.Y.Z]` link to `releases/tag/vX.Y.Z`. An empty section refuses:
      there is nothing to release.
   3. Runs `scripts/release-policy-check.mjs` against the planned commit,
      the same check as `release.yml`'s `prepare` job ([Checklist](#checklist)),
      before a file is written. A dry run stops here and prints the diff.
   4. Writes the files and runs `pnpm run test:unit` (`--skip-tests` skips
      it). A failure restores every file it wrote.
   5. Commits `chore(release): vX.Y.Z` and creates the annotated tag
      `vX.Y.Z`. It never pushes. It prints the push commands and what each
      one starts. To undo: `git tag -d vX.Y.Z && git reset --hard HEAD~1`.

   The rewrites are `scripts/lib/release.mjs`, tested in
   `scripts/lib/release.test.mjs`; the git and shell half is
   `scripts/release.mjs`. Prereleases (`v0.2.0-rc.1`) are tagged by hand: the
   stores take no prerelease version and the policy check skips their
   written record.

3. **Push `main`, then the tag.** The tag must contain the dated changelog
   entry and the version bump. The workflows build what GitHub has, not your
   local checkout.

   ```bash
   git push origin main && git push origin v0.1.0
   ```

   `main` starts `build-and-deploy.yml`, which deploys the hosted app. The
   tag starts `release.yml` (self-host images), `extension-release.yml`
   (browser extension), `desktop-release.yml` (desktop downloads into a
   draft release), and `release-summary.yml` each time one of them finishes.
   `mobile-release.yml` runs on manual dispatch only.

   An optional dry run of the images before the tag: Actions → release → Run
   workflow, on `main`, with `tag` empty and `push` unchecked. It builds both
   images on both arches and pushes nothing. It also fills the build cache
   that the tag run reads.

4. **Watch the runs.**

   ```bash
   pnpm release:status            # the newest local v* tag
   pnpm release:status v0.1.0
   ```

   One table: channel, workflow, result, run URL, and what the run did — smoke
   and promote for the images, whether the store upload ran or was skipped
   and why, how many desktop channels built and whether the draft exists or
   is published, the Play and TestFlight uploads. It reads through `gh api`
   only (`scripts/release-status.mjs`, tested in
   `scripts/lib/release-status.test.mjs`). On GitHub, the same table is the
   step summary of the newest `Release Summary` run for the tag
   (`.github/workflows/release-summary.yml`, started by each tag workflow
   finishing, `actions: read` and `contents: read` only).

   **On the first release, `smoke` fails, and that is expected.** GHCR creates
   a new package as private, so the anonymous pull of
   `trackyourtime-client-selfhost` is denied. `promote` is skipped, so `0.1` and
   `latest` do not exist yet. To fix it:

   1. Open
      <https://github.com/users/trebeljahr/packages/container/trackyourtime-client-selfhost/settings>.
   2. Change visibility → Public. This cannot be changed back.
   3. Check `trackyourtime-server` is also Public.
   4. In the failed run, click "Re-run failed jobs". This re-runs `smoke` and
      then `promote`. Nothing is rebuilt.

5. **Check it from your own machine.** Use a separate colima profile, never
   the default VM:

   ```bash
   colima start -p tt-verify --cpu 2 --memory 2
   docker context use colima
   DOCKER_CONTEXT=colima-tt-verify CHECK_FLOATING=1 scripts/verify-release-images.sh v0.1.0
   colima stop -p tt-verify
   ```

   `colima start -p` switches the global Docker context to the new profile.
   The `docker context use colima` line switches it back, so only the
   `DOCKER_CONTEXT=` command uses the test VM.

   The last line is `PASS: …` or `FAIL: …`. The script pulls with an empty
   Docker config, so your own registry login is not used and not changed. It
   removes only its own compose project. `CHECK_FLOATING=1` also checks that
   `0.1` and `latest` point at `v0.1.0`.

   Without Docker, `REGISTRY_ONLY=1` checks only that both tags can be pulled
   anonymously and list both arches.

6. **Check nothing else ran, then publish the release page.** Actions should
   show one `release`, one `Extension Release` and one `Desktop Release` run
   for the tag, plus the `Release Summary` runs they started, and no mobile
   run. With the store secrets set, the extension run has submitted the new
   version for review. Without them it is green with the notice "store upload
   skipped".

   The desktop run leaves a **draft** release for the tag with the downloads
   attached and a placeholder body. Put the release notes on it and publish
   it. Publishing is the desktop release: installed apps update from the
   next published release they see.

   ```bash
   gh release edit v0.1.0 --title "v0.1.0" --notes-file docs/release-notes/v0.1.0.md
   gh release edit v0.1.0 --draft=false
   ```

   If no draft exists (every desktop leg failed), create the page yourself:

   ```bash
   gh release create v0.1.0 --title "v0.1.0" --notes-file docs/release-notes/v0.1.0.md --verify-tag
   ```

   Then, for the package managers, run Desktop Manifests from the tag
   (docs/deploy.md → "Desktop release").

7. **On the first release only, remove the "no release yet" statements.**
   They are true until step 5 passes and false after it. Find them with:

   ```bash
   grep -rniE "no (tagged )?release|tagged releases|nothing to pull|until the first release|first build" \
     README.md packages/client/src/components/marketing scripts/llms docs-site/docs/choosing-a-self-hosted-time-tracker.md
   ```

   `docs/self-hosting.md` and `SECURITY.md` are written to stay true inside
   the tag, so they need no change.

   Then run `pnpm docs:sync` and `pnpm llms:emit`, and commit the result.
   `pnpm test:unit` fails while the generated copies are out of date.

## Re-publishing a tag

Actions → release → Run workflow, with `tag` set to the existing tag and
`push` checked. It rebuilds from that tag's commit and runs the same jobs.
Re-publishing an older release does not move `latest` or `X.Y` backwards.

## When a job fails

- **`smoke`: "anonymous pull … was denied".** A package is still private. See
  step 4.
- **`smoke`: "tag not published".** `merge` did not finish for that image.
  Check its log.
- **`smoke`: health or routing check.** The step prints `docker compose ps`
  and the last 200 log lines of each container. Do not move `latest` by hand.
  Fix the problem and cut a new patch tag.
- **`merge`: "attestation manifest(s)".** Provenance or SBOM was lost when the
  digests were joined. The exact tag is already pushed. `smoke` and `promote`
  did not run.

## Chrome Web Store

`.github/workflows/extension-release.yml` publishes new versions of the
browser extension to the existing store item `opibnndhibnigcfgfbgbipakadhnbjfi`
(`STORE_EXTENSION_ID` in `packages/shared/src/store-clients.ts`) through the
[Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/api).
The logic is `scripts/chrome-web-store.mjs`, tested in
`scripts/lib/chrome-web-store.test.mjs`.

The API only updates an item that exists. Creating the item, the store
listing, the privacy answers and the distribution settings are dashboard work.
After a visibility change in the dashboard, publish once by hand. Until then
the API cannot publish.

### Server trust and permissions

The hosted server must trust the store extension before any release reaches
users. The extension has no host permissions, so every request it sends is a
CORS request. The server answers CORS only for trusted origins. In the server
app's env fields in Coolify, set `TRUST_STORE_APPS=true`, or add
`chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi` to `TRUSTED_ORIGINS`.
Then check the answer:

```bash
curl -s -H 'Origin: chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi' \
  https://api.trackyourtime.dev/api/health
```

The JSON must contain `"originTrusted": true`. See
[deploy.md → TRUSTED_ORIGINS](./deploy.md#trusted_origins).

The dashboard's Privacy tab asks for a reason per permission. The manifest
declares these, and `packages/extension/src/manifest.test.ts` fails if the
list changes:

| Permission | Justification |
|---|---|
| `storage` | Keeps the session, settings, the server address and changes made offline until they are sent. |
| `alarms` | Updates the running time on the toolbar badge every 30 seconds, checks a pending "Sign in with the web app" approval, and runs activity capture's once-a-minute check when capture is on. |
| `idle` | Detects when you leave the computer with a timer running, so the extension can ask what to do with that time. |
| `tabs` (optional) | Activity capture only. Requested from the click that turns it on. Records which website is in front, on the device. |

The manifest has no `host_permissions`, no `optional_host_permissions` and no
`cookies`. `externally_connectable` lists `https://trackyourtime.dev/*`. It is
not a permission and Chrome shows no install warning for it. It lets the
Track Your Time web app tell the extension that you signed in or out there.

### What a run does

1. Builds `pnpm run build:extension:prod` (`packages/extension/dist-prod`).
2. Checks that the manifest `version` equals the tag without its `v`. The
   version comes from the root `package.json`.
3. Checks that the manifest `key` pins the store item, then removes `key` from
   the zipped manifest. The key is public, but the API docs do not say that an
   update accepts one, and the store keeps the item's own key. The zip is
   refused if it holds a `.pem`, a `.crx`, an `.env` file or a private key.
4. Zips the directory contents with `manifest.json` at the root and uploads
   the zip as a workflow artifact, `chrome-extension-X.Y.Z`.
5. Uploads the zip to the store and polls `fetchStatus` until the upload is
   processed.
6. Submits the item for review, unless the mode is `upload`.
7. Prints the item status: the published and submitted revisions, their
   versions and deploy percentages.

Any API error, a `FAILED` upload, or a submission state other than
`PENDING_REVIEW`, `STAGED`, `PUBLISHED` or `PUBLISHED_TO_TESTERS` fails the job.

### When it runs

| Trigger | Result |
|---|---|
| `vX.Y.Z` tag, secrets set | Submits for review. Published when review passes. |
| `vX.Y.Z` tag, no secrets | Artifact only, with a notice. |
| Prerelease tag (`v0.2.0-rc.1`) | Artifact only, with a notice. The store has one public channel. |
| Only one of the two secrets set | Fails with `::error::`. |
| Actions → Extension Release → Run workflow | `mode` `build`, `upload` or `publish`. `upload` and `publish` need `tag` and both secrets. |

Dispatch inputs:

- `mode: upload` uploads the package as a draft and does not submit it. Use
  it as a dry run for the store half. A later `publish` run of the same tag
  uploads again and submits.
- `deploy-percentage` sets the initial rollout percentage for `publish`.
  Empty keeps the value saved in the dashboard. The store allows a partial
  rollout only for items with more than 10,000 seven-day active users.
- `staged` holds the approved version until you publish it in the dashboard.

When a run fails:

- **Upload refused because of the version.** The store already has this
  version or a higher one. Bump the root `package.json` and cut a new patch
  tag.
- **Upload succeeded, submission failed.** The new package is in the
  dashboard as a draft. Fix the cause the log names, for example a review
  still pending, then click "Submit for review" in the dashboard. A re-run
  uploads the same version again, which the store can refuse.
- **Token exchange failed.** Check that `CWS_SERVICE_ACCOUNT_JSON` is the
  whole key file and that the service account is linked in the dashboard.

### One-time setup

Do these once, after the item exists in the dashboard.

The version you uploaded by hand is the published version. A tag with the same
version fails at upload once the secrets are set. Add the secrets after that
tag has run, or bump to the next version before the first automated release. The API supports
[service accounts](https://developer.chrome.com/docs/webstore/service-accounts),
so no OAuth consent screen and no refresh token are needed.

1. Turn on 2-step verification for the Google account that owns the
   publisher. The store requires it to publish or update an item.
2. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, or select one, for example `trackyourtime-release`.
3. APIs & Services → Library → search "Chrome Web Store API" → Enable.
4. IAM & Admin → Service Accounts → Create service account, for example
   `chrome-web-store-publisher`. Grant it no project roles.
5. Open the service account → Keys → Add key → Create new key → JSON. The
   file downloads once. Keep it out of the repository.
6. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open Account and add the service account's email
   (`…@<project>.iam.gserviceaccount.com`) as the service account. A
   publisher can link one service account only.
7. In the Developer Dashboard, Publisher → Settings shows the publisher ID.
8. In GitHub, Settings → Secrets and variables → Actions, add two repository
   secrets:
   - `CWS_SERVICE_ACCOUNT_JSON`: the whole JSON key file.
   - `CWS_PUBLISHER_ID`: the publisher ID.
9. Delete the local copy of the JSON key.
10. Test it: Actions → Extension Release → Run workflow, `tag` set to the
    newest tag, `mode: upload`. If the store already has that version, the
    upload fails with the store's own message, which also proves the
    credentials work. Otherwise it leaves a draft that the next `publish`
    run replaces.

To rotate the key, create a new JSON key for the same service account, replace
`CWS_SERVICE_ACCOUNT_JSON`, and delete the old key in the Cloud Console.
