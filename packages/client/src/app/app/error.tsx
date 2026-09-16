"use client";

import { ErrorView } from "@/components/error-view";

/**
 * Errors thrown while rendering a signed-in screen. The app layout stays
 * mounted around it, so navigation still works; a failed chunk load after a
 * deploy is reloaded once (see ErrorView).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return <ErrorView error={error} reset={reset} />;
}
