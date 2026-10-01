import { fileURLToPath } from "node:url";
import { hmrOptions } from "./hmr-options.mjs";

try {
  const options = hmrOptions(process.argv.slice(2), process.env);
  if (options.help) {
    console.log(`Usage: pnpm hmr:extension [--backend live|local|URL] [--local]

  pnpm hmr:extension                               Live API (default)
  pnpm hmr:extension --backend local               Local API on port 5159
  pnpm hmr:extension --backend http://127.0.0.1:54321
  pnpm hmr:extension --backend https://api.example.com

Explicit flags override VITE_API_URL. Local targets use packages/extension/dist;
live and remote targets use packages/extension/dist-prod. Start the backend
separately. A server saved in the popup still overrides the build default;
use Change server in the popup to change an existing saved selection.`);
  } else {
    if (options.apiUrl) process.env.VITE_API_URL = options.apiUrl;
    else delete process.env.VITE_API_URL;
    const { createServer } = await import("vite");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const server = await createServer({
      root,
      configFile: fileURLToPath(new URL("../vite.hmr.config.ts", import.meta.url)),
      mode: options.mode,
    });
    const stop = async () => { await server.close(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await server.listen();
    console.log(`HMR backend default: ${options.apiUrl ?? (options.mode === "local-api" ? "http://localhost:5159" : "https://api.trackyourtime.dev")}`);
    console.log("An existing popup server selection takes precedence; use Change server if needed.");
    server.printUrls();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
