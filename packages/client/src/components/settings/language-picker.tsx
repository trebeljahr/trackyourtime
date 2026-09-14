"use client";

import * as React from "react";
import { Languages } from "lucide-react";
import type { LocalePreference } from "@starter/shared";

import { OptionGroup, type Option } from "@/components/settings/option-group";
import { SettingRow } from "@/components/settings/setting-row";
import { PSEUDO_LOCALE_ENABLED } from "@/i18n/config";
import {
  setLocalePreference,
  setPseudoLocale,
  useLocalePreference,
} from "@/i18n/locale-store";
import { useT } from "@/i18n/use-t";

type LanguageChoice = LocalePreference | "pseudo";

export type LanguagePickerProps = {
  /** Show the pseudo-locale option. Defaults to "not a production build". */
  allowPseudo?: boolean;
};

/**
 * System / English / Deutsch, saved to the account.
 *
 * "English" and "Deutsch" are written in their own language in every locale
 * (the catalog repeats them verbatim), so a person who landed in the wrong one
 * can still find their way out. Only "System" is translated — it describes
 * this device rather than naming a language.
 *
 * The change goes through the locale store, not `settings.update` directly:
 * the store applies it at once (no round trip between the click and the
 * re-render, and the choice survives a reload via localStorage), and
 * <LocaleSync> carries it to the server. The pseudo-locale never reaches the
 * server at all — it is a per-browser development switch.
 */
export function LanguagePicker({
  allowPseudo = PSEUDO_LOCALE_ENABLED,
}: LanguagePickerProps): React.JSX.Element {
  const t = useT("settings");
  const { preference, pseudo } = useLocalePreference();

  const options: Option<LanguageChoice>[] = [
    { value: "system", label: t("language.system"), testId: "language-system" },
    { value: "en", label: t("language.en"), testId: "language-en" },
    { value: "de", label: t("language.de"), testId: "language-de" },
    ...(allowPseudo
      ? [{ value: "pseudo" as const, label: t("language.pseudo"), testId: "language-pseudo" }]
      : []),
  ];

  const onChange = (choice: LanguageChoice): void => {
    if (choice === "pseudo") {
      setPseudoLocale(true);
      return;
    }
    if (pseudo) setPseudoLocale(false);
    setLocalePreference(choice);
  };

  return (
    <SettingRow
      title={t("language.title")}
      description={t("language.description")}
      testId="setting-language"
    >
      <div className="inline-flex max-w-full items-center gap-2">
        <Languages className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <OptionGroup
          label={t("language.title")}
          className="min-w-0"
          value={allowPseudo && pseudo ? "pseudo" : preference}
          options={options}
          onChange={onChange}
        />
      </div>
    </SettingRow>
  );
}
