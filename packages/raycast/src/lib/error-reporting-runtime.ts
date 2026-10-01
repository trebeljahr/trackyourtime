import { getPreferenceValues } from "@raycast/api";
import { createReporter } from "./error-reporting.js";
import { APP_VERSION } from "./version.js";
import { REPORT_BUILD_ID } from "./report-build.js";

let reporter: ReturnType<typeof createReporter> | undefined;
export function reportRaycastError(error: unknown, source: string): void {
  try {
    reporter ??= createReporter(
      getPreferenceValues<Preferences>().errorReportDsn ?? "",
      `trackyourtime-raycast@${APP_VERSION}+${REPORT_BUILD_ID}`,
      REPORT_BUILD_ID,
    );
    reporter(error, source);
  } catch {
    // Diagnostics must not replace the command's own error handling.
  }
}
