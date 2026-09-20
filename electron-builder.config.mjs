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
  appId: "com.trebeljahr.trackyourtime",
  productName: "Track Your Time",
  directories: {
    output: "release",
    buildResources: "build",
  },
  // The root package.json has no "main"; this is the one that ships.
  extraMetadata: {
    main: "electron/dist/main.js",
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
  mac: {
    target: ["dmg", "zip"],
    icon: "build/icon.icns",
    category: "public.app-category.utilities",
  },
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
  },
  linux: {
    target: ["AppImage"],
    icon: "build/icon.png",
    category: "Utility",
  },
};

export default config;
