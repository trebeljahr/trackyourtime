// Local-only interaction study. No API, credentials, native tray or OS shortcuts.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const settingsBundle = await build({
  entryPoints: [path.join(root, "electron/src/desktop-settings.ts")],
  bundle: true, write: false, platform: "node", format: "esm", target: "node24",
});
const { defaultDesktopSettings } = await import(`data:text/javascript;base64,${Buffer.from(settingsBundle.outputFiles[0].text).toString("base64")}`);
const output = path.resolve(process.argv[2] ?? path.join(root, "test-results/desktop-shell-lab"));
const bundle = await build({
  entryPoints: [path.join(root, "scripts/desktop-shell-lab/main.ts")],
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022",
  define: { __DEFAULT_SETTINGS__: JSON.stringify(Object.fromEntries(
    ["darwin", "win32", "linux"].map((platform) => [platform, defaultDesktopSettings(platform)]),
  )) },
});
const html = await readFile(path.join(root, "scripts/desktop-shell-lab/index.html"), "utf8");
const css = await readFile(path.join(root, "scripts/desktop-shell-lab/style.css"), "utf8");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "index.html"), html.replace("/* STYLES */", () => css)
  .replace("/* SCRIPT */", () => bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")));
console.log(path.join(output, "index.html"));
