/** Resolve CLI options before starting Vite or opening a listening socket. */
export function hmrOptions(args, env = {}) {
  let backend;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { help: true };
    let value;
    if (arg === "--local") value = "local";
    else if (arg === "--backend") value = args[++index];
    else if (arg.startsWith("--backend=")) value = arg.slice("--backend=".length);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    if (!value || value.startsWith("--")) throw new Error("--backend needs live, local, or an HTTP(S) origin.");
    if (backend !== undefined) throw new Error("Choose one backend option.");
    backend = value;
  }
  const selected = backend ?? env.VITE_API_URL ?? "local";
  if (selected === "live") return { mode: "hosted", apiUrl: undefined };
  if (selected === "local") return { mode: "local-api", apiUrl: undefined };
  let url;
  try { url = new URL(selected); } catch { throw new Error("Backend must be live, local, or an absolute HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTP(S) backend origin without credentials, paths, queries, or fragments.");
  }
  // Mode selects only the backend default; HMR always uses a development identity.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { mode: local ? "local-api" : "hosted", apiUrl: url.origin };
}
