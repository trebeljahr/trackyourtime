"use client";

import * as React from "react";
import type { LocalePreference } from "@starter/shared";

import { ORIGIN_ID } from "@/hooks/use-sync";
import { adoptLocalePreference, setLocaleSink } from "@/i18n/locale-store";
import { trpc } from "@/lib/trpc";

/**
 * Keeps the language preference in step with the server, in both directions —
 * the same contract as <ThemeSync>, minus its migration (no browser held a
 * language choice before the preference was synced, so there is nothing local
 * to push up).
 *
 * The server stores the PREFERENCE ("system" | "en" | "de"), never the
 * resolved language: "system" means each device answers with its own
 * `navigator.languages`, so one account reads German on a German phone and
 * English on an English laptop.
 *
 * Renders nothing; mounted once, in the app shell. Signed-out screens have no
 * session to sync with and simply use this device's stored copy.
 */
export function LocaleSync(): null {
  const utils = trpc.useUtils();
  const query = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const mutation = trpc.settings.update.useMutation({
    onSuccess: (updated) => {
      utils.settings.get.setData(undefined, updated);
    },
  });
  const { mutate } = mutation;

  /** The choice this tab sent and has not seen confirmed — see ThemeSync. */
  const pending = React.useRef<LocalePreference | null>(null);

  const push = React.useCallback(
    (preference: LocalePreference): void => {
      pending.current = preference;
      mutate({ locale: preference, originId: ORIGIN_ID });
    },
    [mutate],
  );

  React.useEffect(() => {
    setLocaleSink(push);
    return () => setLocaleSink(null);
  }, [push]);

  // Absent while an older server (one that predates the field) answers.
  const serverLocale: LocalePreference | undefined = query.data?.locale;

  React.useEffect(() => {
    if (serverLocale === undefined) return;
    if (pending.current !== null && pending.current !== serverLocale) return;
    pending.current = null;
    adoptLocalePreference(serverLocale);
  }, [serverLocale]);

  return null;
}
