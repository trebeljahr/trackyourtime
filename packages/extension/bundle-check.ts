import type { Plugin } from "vite";

/** Extension pages have no import map or server to resolve external packages. */
export function bundleCheck(): Plugin {
  return {
    name: "trackyourtime:bundle-check",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const dependency of [...output.imports, ...output.dynamicImports]) {
          if (!(dependency in bundle)) {
            this.error(
              `Extension bundle ${output.fileName} imports unbundled dependency "${dependency}". All runtime dependencies must be bundled.`,
            );
          }
        }
      }
    },
  };
}
