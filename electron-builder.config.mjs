import { artifactPatterns, updateFeedFor } from "./scripts/lib/desktop-release.mjs";

/*
 * Set by scripts/build-desktop.mjs from the signing secrets
 * (scripts/lib/desktop-release.mjs): no secrets at all builds an artifact
 * named -unsigned, never one that looks like a release.
 */
const unsigned = process.env.TRACKYOURTIME_UNSIGNED === "1";
const names = artifactPatterns({ unsigned });
/** Set by build-desktop.mjs (`builderEnvFor`); "local" without --channel. */
const channel = process.env.TRACKYOURTIME_DESKTOP_CHANNEL;
const env = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

/**
 * electron-builder configuration for Track Your Time.
 *
 * Run it through `scripts/build-desktop.mjs --package …` (`pnpm electron:build`,
 * `pnpm electron:preview`), which builds and verifies what this packs first.
 *
 * The package contains exactly two things besides package.json: the bundled
 * main/preload (`electron/dist`) and the desktop export
 * (`packages/client/out-desktop`). The main process is one esbuild bundle with
 * no runtime `node_modules`, so none are packed — the root `dependencies` are
 * the Capacitor plugins, and they have no business in a desktop binary.
 *
 * @type {import("electron-builder").Configuration}
 */
const config = {
  // The legacy ARM64 runtime links to libz.so, a development-only symlink.
  // The static runtime starts without that library on the host.
  toolsets: { appimage: "1.0.3" },
  appId: "com.ricoslabs.trackyourtime",
  productName: "Track Your Time",
  directories: {
    output: "release",
    buildResources: "build",
  },
  // The root package.json has no "main"; this is the one that ships.
  copyright: "Copyright © 2026 Rico Trebeljahr",
  extraMetadata: {
    main: "electron/dist/main.js",
    // deb and rpm refuse to build without a homepage, and the root
    // package.json is the monorepo's, not the app's.
    homepage: "https://trackyourtime.dev",
    author: { name: "Rico Trebeljahr" },
  },
  files: [
    "package.json",
    "electron/dist/**",
    "packages/client/out-desktop/**",
    "!**/*.map",
    "!packages/client/out-desktop/.build-target.json",
    // electron-builder adds the app's production dependencies on its own,
    // whatever `files` lists; this is what keeps them out.
    "!node_modules/**",
  ],
  // The update feed (Stage 7): GitHub Releases for signed mac and win builds
  // and for Linux, `null` for everything else. Explicitly null — left
  // undefined, electron-builder guesses a GitHub feed from GH_TOKEN.
  // build-desktop.mjs always passes --publish never; the release workflow
  // uploads to a draft release itself.
  publish: updateFeedFor({ channel, unsigned }),
  asar: true,
  // Nothing native is packed, so there is nothing to rebuild.
  npmRebuild: false,
  nodeGypRebuild: false,
  // Flipped by electron-builder right before signing (it must be before, or
  // the signature breaks); `resetAdHocDarwinSignature` re-signs unsigned arm64
  // builds, which macOS otherwise refuses to launch after a fuse flip.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: true,
  },
  // ── macOS, Developer ID (dmg + zip) ────────────────────────────────
  // Split arm64 and x64 rather than universal: each download is half the size,
  // and the Homebrew cask picks the right one per machine. Notarization runs
  // when APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER are set, which
  // build-desktop.mjs only allows together with the certificate.
  mac: {
    target: ["dmg", "zip"],
    icon: "build/icon.icns",
    category: "public.app-category.productivity",
    // Only with a real identity. An unsigned build is ad-hoc signed, and an
    // ad-hoc signature has no Team ID; the hardened runtime's library
    // validation then refuses Electron Framework at launch ("mapping process
    // and mapped file (non-platform) have different Team IDs") and dyld
    // aborts before any of our code runs.
    hardenedRuntime: !unsigned,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: !unsigned,
    extendInfo: {
      // HTTPS and the OS's own crypto only: exempt from export documentation.
      // App Store Connect asks on every upload without it; harmless outside.
      ITSAppUsesNonExemptEncryption: false,
      // Electron reads it in a Mac App Store build to name its sandboxed IPC
      // channels (the app group); ignored by the Developer ID build.
      ...(env("APPLE_TEAM_ID") ? { ElectronTeamID: env("APPLE_TEAM_ID") } : {}),
    },
    // Applies to the zip (dmg has its own below); electron-builder has no
    // top-level `zip` block.
    artifactName: names.zip,
  },
  dmg: {
    artifactName: names.dmg,
  },
  // ── macOS, Mac App Store (pkg) ─────────────────────────────────────
  // Universal, because App Store Connect takes one binary per build. The
  // sandbox entitlements are generated per build (they name the team), the
  // helpers inherit the sandbox, and there is no hardened runtime: the store
  // re-signs. What the sandbox build leaves out is in docs/desktop-app-plan.md
  // (Stage 6) and electron/src/distribution.ts.
  mas: {
    type: "distribution",
    hardenedRuntime: false,
    // Unsigned, skip signing outright. The ad-hoc fallback electron-builder
    // uses for `mac` fails here: @electron/osx-sign derives ElectronTeamID
    // from the identity and "-" has none ("Could not automatically determine
    // ElectronTeamID"). Inventing a team id would only hide that. An unsigned
    // run therefore checks the config and yields release/mas-*/…app, no pkg
    // (productbuild needs the installer identity).
    ...(unsigned ? { identity: null } : {}),
    entitlements: "build/generated/entitlements.mas.plist",
    entitlementsInherit: "build/entitlements.mas.inherit.plist",
    provisioningProfile: env("MAS_PROVISIONING_PROFILE") ?? null,
    artifactName: names.mas,
    // No `extendInfo` here: app-builder-lib 26.8.1 builds Info.plist from
    // `mac.extendInfo` only and silently drops a `mas` one. The keys the store
    // build needs are in `mac` above; build-desktop.mjs checks they arrived.
  },
  // ── Windows, direct download (NSIS) ────────────────────────────────
  // Signed either with a certificate file (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD,
  // read by electron-builder itself) or with Azure Trusted Signing, never both.
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
    ...(env("AZURE_TRUSTED_SIGNING_ENDPOINT")
      ? {
          azureSignOptions: {
            endpoint: env("AZURE_TRUSTED_SIGNING_ENDPOINT"),
            codeSigningAccountName: env("AZURE_TRUSTED_SIGNING_ACCOUNT"),
            certificateProfileName: env("AZURE_TRUSTED_SIGNING_PROFILE"),
            publisherName: env("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
          },
        }
      : {}),
  },
  nsis: {
    artifactName: names.nsis,
    oneClick: true,
    perMachine: false,
  },
  // ── Windows, Microsoft Store (AppX) ────────────────────────────────
  // Uploaded to Partner Center, which signs it. The identity is read from the
  // environment and never defaulted: build-desktop.mjs refuses the win-store
  // channel without all three. Tiles come from build/appx/ (icons:brand).
  appx: {
    artifactName: names.appx,
    identityName: env("WINDOWS_STORE_IDENTITY_NAME"),
    publisher: env("WINDOWS_STORE_PUBLISHER"),
    publisherDisplayName: env("WINDOWS_STORE_PUBLISHER_DISPLAY_NAME"),
    applicationId: "TrackYourTime",
    displayName: "Track Your Time",
    backgroundColor: "#4F46E5",
    languages: ["en-US", "de-DE"],
  },
  // ── Linux ──────────────────────────────────────────────────────────
  // AppImage for anyone, deb and rpm for the two package families, tar.gz as
  // the input Flathub's manifest (packaging/flatpak/) repackages, and snap for
  // the Snap Store. electron-builder's own `flatpak` target is not used: it
  // makes a local single-file bundle, and Flathub builds from a manifest in
  // its own repository instead.
  linux: {
    target: ["AppImage", "deb", "rpm", "tar.gz", "snap"],
    icon: "build/icon.png",
    category: "Utility",
    executableName: "trackyourtime",
    synopsis: "Free, open-source time tracking",
    maintainer: "Rico Trebeljahr",
    vendor: "Rico Trebeljahr",
    artifactName: names.linux,
  },
  // `depends` REPLACES electron-builder's default list rather than adding to
  // it, so each of these repeats the defaults and then names what Electron
  // really links against and the defaults leave out. Measured on a bare
  // Debian and a bare Fedora with `pnpm test:desktop:packages`, which installs
  // the package in an image carrying no desktop libraries at all: v0.1.2 shipped
  // a .deb that died on `libgbm.so.1: cannot open shared object file` and an
  // .rpm that died on `libasound.so.2`, because gtk3 happens to pull libgbm on
  // Fedora and nothing pulls ALSA on either. Adding a target here means
  // checking it the same way; a dependency satisfied only transitively today is
  // one the next base-image change removes.
  deb: {
    // electron-builder's default names (trackyourtime_0.1.0_amd64.deb), which
    // is what apt users expect.
    artifactName: "${name}_${version}_${arch}.${ext}",
    depends: [
      // electron-builder's defaults.
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      // Both are DT_NEEDED of the Electron binary and in neither default list:
      // libgbm for the GPU/compositor path, ALSA for audio.
      "libgbm1",
      "libasound2",
    ],
  },
  rpm: {
    artifactName: "${name}-${version}.${arch}.${ext}",
    // FPM's default xzmt compression exhausts a 2 GB Linux builder while
    // packing Electron. gzip uses less memory; the larger RPM is intentional.
    compression: "gzip",
    depends: [
      // electron-builder's defaults.
      "gtk3",
      "libnotify",
      "nss",
      "libXScrnSaver",
      "(libXtst or libXtst6)",
      "xdg-utils",
      "at-spi2-core",
      "(libuuid or libuuid1)",
      // alsa-lib is DT_NEEDED; mesa-libgbm is too and only arrives because
      // gtk3 happens to pull it, which is not a dependency anyone declared.
      "alsa-lib",
      "mesa-libgbm",
      // safeStorage dlopens libsecret, so ldd never names it and the app
      // silently keeps the session in memory instead (electron/src/secure-store.ts).
      // The .deb has always declared it; the rpm default list does not.
      "libsecret",
    ],
  },
  // x64 only, and there is no `base` here on purpose. electron-builder builds
  // this snap from its prebuilt template (`isUseTemplateApp` in
  // app-builder-lib/out/targets/snap.js), which writes meta/snap.yaml and runs
  // mksquashfs — snapcraft is never invoked, so nothing here is subject to
  // snapcraft 9 dropping core20. The template's own `base: core20` is the
  // default, and it is a description of the template rather than a choice:
  // the staged libraries and the `gnome-3-28-1804` content plug inside it are
  // core20-era. Setting `base` to core22 or core24 would change only the line
  // snapd reads, leaving it naming a runtime the packed files were not built
  // against — a snap that builds green and is broken on install.
  //
  // arm64 gets no snap: no arm64 template is published, so that arch falls
  // through to real snapcraft, which refuses core20 (workflow header, and
  // docs/desktop-app-plan.md → Stage 6). Moving the base would not rescue it
  // either — snapcraft does not validate `base` under --destructive-mode
  // (canonical/snapcraft#4562), so core22 on the noble runner would stage
  // noble's libraries into a snap claiming jammy's runtime, and core24 would
  // still be built from this core20-shaped template. A correct arm64 snap
  // needs a hand-written snapcraft.yaml, which is upstream's own advice
  // (electron-userland/electron-builder#9233) and is not done here.
  snap: {
    artifactName: "${name}_${version}_${arch}.${ext}",
    grade: "stable",
    confinement: "strict",
    summary: "Free, open-source time tracking",
    // One line, and one line only. electron-builder writes the snap's
    // description into the snapcraft.yaml AND into the desktop entry's
    // `Comment=` (LinuxTargetHelper.computeDesktopEntry, reached by both the
    // core24 and the legacy snap strategies), where a newline is escaped to a
    // literal `\n` — so a paragraph here reads as one run-on tooltip with
    // `\n` in it, and before 26.17 escaped nothing and broke the file outright.
    // The full Snap Store listing text is pasted into the listing page by hand
    // (docs/linux-stores.md → "The listing").
    description: "Free, open-source time tracking for people who bill by the hour.",
    // `password-manager-service` lets safeStorage reach the Secret Service; it
    // is not auto-connected, and without it the app keeps the session in
    // memory and says so in Settings → Devices (secure-store.ts).
    plugs: ["default", "password-manager-service"],
    // snapd starts the app at login when $SNAP_USER_DATA/.config/autostart
    // holds trackyourtime.desktop, which is where login-item.ts writes it.
    autoStart: true,
  },
};

export default config;
