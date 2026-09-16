# Releasing

A release is a `vX.Y.Z` git tag. Pushing one runs
`.github/workflows/release.yml`, which publishes two images for self-hosters:

- `ghcr.io/trebeljahr/trackyourtime-server`
- `ghcr.io/trebeljahr/trackyourtime-client-selfhost`

Both are built for `linux/amd64` and `linux/arm64`. Nothing is deployed, and
no GitHub Release is created. The hosted instance still deploys from
`build-and-deploy.yml` on every push to `main`.

The same tag also runs `.github/workflows/extension-release.yml`, which builds
the browser extension and, once its secrets exist, submits it to the Chrome
Web Store. Without the secrets it only uploads the zip as an artifact. See
[Chrome Web Store](#chrome-web-store).

A tag runs no other workflow. `desktop-release.yml`, `mobile-release.yml` and
`tauri-release.yml` run on manual dispatch only.

## What the workflow does

| Job | Result |
|---|---|
| `prepare` | Resolves the version, the commit, and whether `X.Y` and `latest` may move. |
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

## Steps

1. **Set the version, date the changelog, then push `main`.** Set
   `"version"` in the root `package.json` to `X.Y.Z`. It is the one version
   number. `/version.json`, the web bundle and the browser extension's
   manifest read it, and `pnpm build:mobile` fails until the iOS
   `MARKETING_VERSION` and the Android `versionName` match it. The other
   hand-kept copies (Tauri, Raycast, the MCP server, the workspace
   `package.json` files) fail `pnpm run test:unit` until they match:
   `scripts/lib/version-sync.test.mjs` names each one. `extension-release.yml`
   fails before it uploads anything when the manifest does not match the tag,
   because the Chrome Web Store refuses a version that is not higher than the
   published one. If the release added a tRPC procedure, input field, enum
   value or sync event kind, `API_LEVEL` must already be bumped
   (`docs/versioning.md`).

   In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - <release date>`, rewrite its opening
   paragraph in the past tense, and add an empty `## [Unreleased]` above it.
   Point the `[Unreleased]` link at `compare/vX.Y.Z...HEAD` and add a
   `[X.Y.Z]` link to `releases/tag/vX.Y.Z`. Commit it. The tag must contain
   the dated entry. The workflow builds what GitHub has, not
   your local checkout. This must print nothing:

   ```bash
   git fetch origin && git rev-list origin/main..main
   ```

2. **Optional dry run.** Actions → release → Run workflow, on `main`, with
   `tag` empty and `push` unchecked. It builds both images on both arches and
   pushes nothing. It also fills the build cache that the tag run reads.

3. **Tag and push the tag.**

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. **Watch the run.** Actions → release.

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

6. **Check nothing else ran.** Actions should show one `release` run and one
   `Extension Release` run for the tag, and no desktop, mobile or tauri runs.
   With the store secrets set, the extension run has submitted the new version
   for review. Without them it is green with the notice "store upload
   skipped".

   Then publish the release page. The workflow creates none. The body is
   written ahead in `docs/release-notes/`:

   ```bash
   gh release create v0.1.0 --title "v0.1.0" --notes-file docs/release-notes/v0.1.0.md --verify-tag
   ```

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
