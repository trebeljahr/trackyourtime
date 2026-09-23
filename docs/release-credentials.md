# Release credentials — what is set, where it came from, what is missing

Written 2026-09-23. The companion to `docs/deploy.md`, which explains how to
*create* each credential. This file records what is **actually configured on
`trebeljahr/trackyourtime` today**, the material it was built from, and the
traps that cost time — so the next run does not rediscover them.

Nothing here contains a secret value. Passwords live in gitignored files named
below; the keys themselves live in `~/keys/`.

## Set and verified (mobile: iOS + Android)

| Secret | Built from | Notes |
| --- | --- | --- |
| `APPLE_API_KEY_BASE64` | `~/Downloads/AuthKey_28G47BVTY7.p8` | ASC API key, team-wide, role App Manager. Named "GitHub Actions — Mesozoic" in the portal but it is an account-level key and works for every app on the team. |
| `APPLE_API_KEY_ID` | `28G47BVTY7` | — |
| `APPLE_API_ISSUER_ID` | `fe992c77-dd56-4ec2-9552-9ffb12bed05f` | From App Store Connect → Users and Access → Integrations. |
| `APPLE_CERTIFICATE_BASE64` | `~/keys/trackyourtime-ci-distribution.p12` | Apple Distribution cert `MTQD5355Z8`, created 2026-09-23 via the ASC API, expires 2027-09-23. Dedicated to CI. |
| `APPLE_CERTIFICATE_PASSWORD` | `.apple-ci-cert.local` | — |
| `APPLE_TEAM_ID` | `4BHY8H2J25` | Only the `mas` desktop channel reads it; set anyway. |
| `ANDROID_KEYSTORE_BASE64` | `~/keys/trackyourtime-upload.keystore` | PKCS12, RSA 4096, alias `trackyourtime`, 10000 days, created 2026-09-23. |
| `ANDROID_KEYSTORE_PASSWORD` | `.android-upload-keystore.local` | Same password for store and key. |
| `ANDROID_KEY_ALIAS` | `trackyourtime` | `android/app/build.gradle` reads `KEY_ALIAS`; the workflow maps the secret to it. |
| `ANDROID_KEY_PASSWORD` | `.android-upload-keystore.local` | — |
| `PLAY_SERVICE_ACCOUNT_JSON` | `~/Downloads/ricos-labs-llc-858d39f120d8.json` | `play-publisher-mesozoic@ricos-labs-llc.iam.gserviceaccount.com`, account-level. Probed 2026-09-23: `edits`, `tracks` and `bundles` all answer 200, so it has release access to this app. |
| `ANDROID_PACKAGE_NAME` | `com.ricoslabs.trackyourtime` | — |

Both preconditions the workflow's plan step checks are satisfied:
`ios/App/App.xcodeproj/project.pbxproj` sets `DEVELOPMENT_TEAM = 4BHY8H2J25`
for both configurations, and `ios/App/ExportOptions.plist` is committed with
`app-store-connect` / automatic signing.

**Back these up off-machine.** The Play upload keystore is enrolled once in
Play App Signing; losing it means a key-reset request to Google before you can
ship another update. `~/keys/` is outside the repo and is not backed up by it.

### Local password files (gitignored via `.git/info/exclude`)

| File | Holds |
| --- | --- |
| `.android-upload-keystore.local` | keystore path, alias, password |
| `.apple-ci-cert.local` | p12 path, password, cert id and SHA-1 |
| `.demo-account.local` | the store reviewers' demo account on production |

They are excluded through `.git/info/exclude`, which is **per-clone**. A fresh
clone does not inherit it — re-add the three lines, or move them to
`.gitignore`, before creating files with these names again.

## Traps, each of which cost time

- **An OpenSSL 3 `.p12` cannot be imported by macOS.** `openssl pkcs12 -export`
  from Homebrew's OpenSSL 3 produces a file that `security import` rejects with
  `MAC verification failed during PKCS12 import (wrong password?)` — the
  password is fine, the MAC algorithm is not. Build the p12 with
  **`/usr/bin/openssl`** (LibreSSL), which macOS and the GitHub runners read.
  Verify before trusting it: import into a throwaway keychain and check
  `security find-identity -v -p codesigning <keychain>` prints one identity.
  A silent `2>/dev/null` on the import hides exactly this failure.
- **Include the WWDR intermediate in the p12** (`-certfile`, from
  `https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer`), or the
  imported identity may not chain to a trusted root on the runner.
- **There is no `keytool` on this Mac** — no JDK on the path. Android Studio
  bundles one at
  `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool`.
- **A partial secret set is a hard error**, by design
  (`scripts/lib/mobile-release.mjs`). Set all four Android signing secrets or
  none; setting the Play upload pair without the signing four fails the run.
- **The `NEXT_PUBLIC_*` repository variables are all unset and that is fine.**
  Every workflow falls back to the production values
  (`https://api.trackyourtime.dev`, `wss://api.trackyourtime.dev`,
  `https://trackyourtime.dev`). Only `NEXT_PUBLIC_SENTRY_DSN` changes behaviour
  by being absent: builds then report no errors, and the run says so.

## Creating an Apple certificate through the ASC API

Used for `MTQD5355Z8`, and the way to make any further one without a GUI. The
existing Xcode identity in the login Keychain cannot be scripted instead —
exporting a private key from the Keychain raises a GUI prompt.

1. `openssl genrsa -out k.key 2048` and `openssl req -new -key k.key -out k.csr -subj "/emailAddress=…/CN=…/O=…/C=DE"`.
2. `POST /v1/certificates` with `{ attributes: { certificateType: "DISTRIBUTION", csrContent: <the PEM, headers included> } }`.
   The response's `attributes.certificateContent` is base64 DER.
3. Decode it, `openssl x509 -inform DER`, then build the p12 with LibreSSL as above.

`certificateType` values worth knowing: `DISTRIBUTION` (Apple Distribution,
iOS + macOS App Store), `DEVELOPER_ID_APPLICATION` (direct-download desktop),
`MAC_INSTALLER_DISTRIBUTION` (the `mas` pkg). Certificates on the team as of
2026-09-23: `MTQD5355Z8` (this CI one), `QM2KDD28ND` (Apple Distribution, the
Xcode/Keychain identity `EB510BF0…`), `4T3QKPKL7R` (Developer ID Application).
Revoking the CI one does not affect the Xcode identity, or the reverse.

The script that did this was a throwaway, not committed. It is small enough to
rewrite from this file: the bearer token is an ES256 JWT with claims
`{ iss: <issuer id>, iat, exp: iat + 900, aud: "appstoreconnect-v1" }` and
header `{ alg: "ES256", kid: <key id>, typ: "JWT" }`, signed with the `.p8`
using Node's `sign("sha256", …, { key, dsaEncoding: "ieee-p1363" })`. The same
token authenticates the screenshot uploads described in
`docs/marketing/README.md`.

## Not set — what each channel still needs

None of these blocks the iOS or Android store submission.

| Channel | Secrets | What has to exist first |
| --- | --- | --- |
| Desktop, macOS direct download | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | A Developer ID Application p12. The cert exists (`4T3QKPKL7R`); its key is in the Keychain, so either export it by hand or mint a CI one through the API as above. |
| Desktop, Mac App Store | `MAS_CSC_LINK`, `MAS_CSC_KEY_PASSWORD`, `MAS_PROVISIONING_PROFILE_BASE64` | One p12 holding **both** Apple Distribution and Mac Installer Distribution, plus a Mac App Store provisioning profile. `APPLE_TEAM_ID` is already set. |
| Desktop, Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, or the Azure set (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`) | A paid Azure Trusted Signing account, or a bought code-signing certificate. |
| Homebrew cask | `HOMEBREW_TAP_TOKEN`, var `HOMEBREW_TAP_REPO` | A tap repository and a token that can push to it. |
| Chrome Web Store | `CWS_SERVICE_ACCOUNT_JSON`, `CWS_PUBLISHER_ID` | A Google Cloud service account authorised for the Chrome Web Store API. Without both, a tag only uploads an artifact. |
| Firefox add-ons | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | An addons.mozilla.org API credential. |

`docs/deploy.md` has the step-by-step for creating each.

## What a first mobile release run does now

`.github/workflows/mobile-release.yml` on a `v*` tag: signs the AAB, uploads it
to the Play track in the `MOBILE_PLAY_TRACK` variable (unset, so `internal`),
archives and exports a signed IPA, and uploads it to TestFlight with `altool`.
Build numbers come from the run number, and both stores refuse a number they
have already seen. A prerelease tag goes to Play's internal track only.

Verified 2026-09-23 by running the planner locally with the secret names set,
which is what the workflow itself does — it reads presence, never values:

```
android: build=signed upload=true track=internal status=completed version=0.1.0
ios:     build=signed upload=true version=0.1.0
```

So a `v0.1.0` tag now produces a signed bundle on both stores rather than the
`-unsigned` artifacts it would have produced before. Re-run it after changing
any secret:

```bash
GITHUB_EVENT_NAME=push GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.1.0 \
  GITHUB_RUN_NUMBER=1 GITHUB_RUN_ATTEMPT=1 GITHUB_OUTPUT=/dev/null \
  ANDROID_KEYSTORE_BASE64=x ANDROID_KEYSTORE_PASSWORD=x ANDROID_KEY_ALIAS=x \
  ANDROID_KEY_PASSWORD=x PLAY_SERVICE_ACCOUNT_JSON=x ANDROID_PACKAGE_NAME=x \
  node scripts/mobile-release-plan.mjs android
```
