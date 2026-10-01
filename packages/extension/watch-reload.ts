import { randomUUID } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Watch builds only. Publish the revision after every output file is on disk. */
export function watchReload(): Plugin {
  let enabled = false;
  let revision = "";
  let outputDir = "";
  return {
    name: "trackyourtime:watch-reload",
    configResolved(config) {
      enabled = Boolean(config.build.watch);
      outputDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      revision = randomUUID();
    },
    generateBundle(_options, bundle) {
      if (!enabled) return;
      const worker = bundle["background.js"];
      if (!worker || worker.type !== "chunk") return;
      // No server, remote code, permissions, or CSP exceptions are needed.
      // The running worker compares its baked-in revision with the file on disk.
      worker.code += `\n;(() => {
        const revision = ${JSON.stringify(revision)};
        let checking = false;
        setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            // Keep the development worker awake so closed popups update too.
            await chrome.runtime.getPlatformInfo();
            const response = await fetch(chrome.runtime.getURL("watch-revision.json"), { cache: "no-store" });
            if (!response.ok) return;
            const next = await response.json();
            if (typeof next.revision === "string" && next.revision !== revision) {
              chrome.runtime.reload();
            }
          } catch {
            // A build may be writing files. Keep the last working extension.
          } finally {
            checking = false;
          }
        }, 1000);
      })();\n`;
    },
    async writeBundle() {
      if (!enabled) return;
      const file = resolve(outputDir, "watch-revision.json");
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({ revision }));
      await rename(temp, file);
    },
  };
}
