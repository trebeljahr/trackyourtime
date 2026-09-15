# Releasing

A release is a `vX.Y.Z` git tag. Pushing one runs
`.github/workflows/release.yml`, which publishes two images for self-hosters:

- `ghcr.io/trebeljahr/trackyourtime-server`
- `ghcr.io/trebeljahr/trackyourtime-client-selfhost`

Both are built for `linux/amd64` and `linux/arm64`. Nothing is deployed, and
no GitHub Release is created. The hosted instance still deploys from
`build-and-deploy.yml` on every push to `main`.

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

The server image reports its commit in `/api/health` as `version`.

## Steps

1. **Date the changelog, then push `main`.** In `CHANGELOG.md`, rename
   `## [Unreleased]` to `## [X.Y.Z] - <release date>`, rewrite its opening
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

6. **Check nothing else ran.** Actions should show one `release` run for the
   tag, and no desktop, mobile or tauri runs.

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
