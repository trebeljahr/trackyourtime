// Where the server talks to, and as whom.
//
// Two variables and nothing else. The hosted API is the default so that the
// common case is one pasted token, and any self-hosted origin works by setting
// the URL — the REST surface is identical on both, because it is the same code.

export const DEFAULT_API_URL = "https://api.trackyourtime.dev";

export type McpConfig = {
  /** Origin the REST API is mounted under, with no trailing slash and no `/api/v1`. */
  apiUrl: string;
  /** A personal API token, `tt_…`, minted in Settings → Integrations → API tokens. */
  token: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Normalise the API URL people actually paste.
 *
 * A self-hoster copies the address bar (`https://track.example.com/`), and an
 * integrator copies the documented base (`…/api/v1`). Both mean the same
 * origin, and refusing either would be a support question with no upside.
 * Anything that is not http(s) is refused rather than guessed at.
 */
export function normaliseApiUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `TRACKYOURTIME_API_URL is not a URL: "${trimmed}". Use an origin such as https://api.trackyourtime.dev or https://track.example.com.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `TRACKYOURTIME_API_URL must start with https:// or http://, got "${url.protocol}".`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

export function resolveConfig(env: NodeJS.ProcessEnv): McpConfig {
  const token = env.TRACKYOURTIME_API_TOKEN?.trim() ?? "";
  if (!token) {
    throw new ConfigError(
      "TRACKYOURTIME_API_TOKEN is not set. Create a token in Track Your Time under Settings → Integrations → API tokens, then pass it to this server as TRACKYOURTIME_API_TOKEN.",
    );
  }
  const rawUrl = env.TRACKYOURTIME_API_URL?.trim() || DEFAULT_API_URL;
  return { apiUrl: normaliseApiUrl(rawUrl), token };
}
