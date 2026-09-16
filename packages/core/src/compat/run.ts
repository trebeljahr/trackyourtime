/**
 * Entry point of the cross-version compatibility suite.
 *
 *   pnpm --filter @starter/core... run build
 *   COMPAT_API_URL=http://127.0.0.1:51590 node packages/core/dist/compat/run.js
 *
 * THIS PATH AND ITS CONFIGURATION ARE A CONTRACT. `.github/workflows/compat.yml`
 * in every later release checks out an older tag and runs that tag's copy of
 * this file exactly as above. Moving the file, renaming the variable or
 * requiring a new one breaks the old-client direction for every release that
 * shipped before the change. Add checks to `suite.ts` instead.
 *
 * Environment:
 *   COMPAT_API_URL         required: the server origin, no path.
 *   COMPAT_CLIENT_VERSION  optional: sent as the client version header.
 *
 * Exit status 0 when every check passed, 1 on a failed check, 2 on a usage
 * error. Written without Node's own types, like the rest of core.
 */
import { runCompatSuite } from "./suite.js";

type NodeProcess = {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const host = (globalThis as { process?: NodeProcess }).process;
const env = host?.env ?? {};

const main = async (): Promise<number> => {
  const baseUrl = env.COMPAT_API_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    console.error("COMPAT_API_URL is required, e.g. COMPAT_API_URL=http://127.0.0.1:51590");
    return 2;
  }
  console.log(`compat suite against ${baseUrl}`);
  try {
    const report = await runCompatSuite({
      baseUrl,
      clientVersion: env.COMPAT_CLIENT_VERSION?.trim() || undefined,
      log: (line) => console.log(line),
    });
    console.log(
      `PASS: ${report.checks.length} checks, client API level ${report.clientApiLevel}, ` +
        `server API level ${report.server.apiLevel}, mode ${report.mode}`,
    );
    return 0;
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};

void main().then((code) => {
  if (host) host.exitCode = code;
});
