import type { JSX } from "react";
import type {
  DurationFormat,
  ResolvedSettings,
  ThemePreference,
  TimeFormat,
  WeekStart,
} from "@starter/core";
import type { Locale, LocalePreference } from "@starter/shared";
import { currencyName, formatDurationFor, formatWeekday } from "../../i18n/format";
import { usePopupLocale, useT, type PopupT } from "../../i18n/use-t";
import type { SettingsPatch } from "../../lib/messaging";
import { NumberField } from "../number-field";
import { SettingRow } from "../accordion";

/**
 * Language, theme, clock, duration, week, money.
 *
 * Language and theme are personal and synced; the popup follows both from the
 * snapshot rather than applying a pick locally.
 *
 * The last three are WORKSPACE fields, and `settings.update` refuses them with
 * FORBIDDEN when the caller's membership role is "member". They are rendered
 * anyway, unconditionally and enabled, for two reasons: no procedure the
 * extension can reach exposes the caller's role, so gating would mean
 * inventing one; and the refusal costs nothing, because
 * `background/settings.ts` writes the settings cache only from a *successful*
 * mutation — the next three-second snapshot re-renders the old value with no
 * rollback code, and the server's own sentence lands in the screen's banner.
 *
 * A personal workspace's single member is its owner, so a solo user never
 * meets it at all.
 */

export type GeneralSectionProps = {
  settings: ResolvedSettings | null;
  onSave: (patch: SettingsPatch) => Promise<boolean>;
};

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

const LANGUAGES: readonly LocalePreference[] = ["system", "en", "de"];

const TIME_FORMATS: readonly TimeFormat[] = ["24h", "12h"];

const DURATION_FORMATS: readonly DurationFormat[] = ["hms", "decimal"];

/** Monday first: the workspace default, and the order most of the world reads. */
const WEEK_STARTS: readonly WeekStart[] = [1, 0];

/**
 * ISO 4217 codes offered in the picker. Any 3-letter code is valid
 * server-side; the names come from `Intl.DisplayNames` in the reader's
 * language, so no list of currency names is kept here.
 */
const CURRENCIES: readonly string[] = [
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "CAD",
  "AUD",
  "NZD",
  "JPY",
  "SGD",
  "HKD",
  "INR",
  "BRL",
  "MXN",
  "ZAR",
];

/** 1.5 hours: the sample every duration-format label is spelled with. */
const SAMPLE_DURATION_SEC = 5400;

const themeLabel = (theme: ThemePreference, t: PopupT): string => {
  switch (theme) {
    case "system":
    default:
      return t("general.themes.system");
    case "light":
      return t("general.themes.light");
    case "dark":
      return t("general.themes.dark");
  }
};

const languageLabel = (language: LocalePreference, t: PopupT): string => {
  switch (language) {
    case "system":
    default:
      return t("general.languages.system");
    case "en":
      return t("general.languages.en");
    case "de":
      return t("general.languages.de");
  }
};

const clockLabel = (format: TimeFormat, t: PopupT): string =>
  format === "12h" ? t("general.timeFormats.12h") : t("general.timeFormats.24h");

/** The closed header's summary: "24-hour · 1:30:00 · EUR". */
export function generalHint(
  settings: ResolvedSettings | null,
  t: PopupT,
  locale: Locale,
): string {
  if (settings === null) return "…";
  return t("general.hint", {
    clock: clockLabel(settings.timeFormat, t),
    duration: formatDurationFor(SAMPLE_DURATION_SEC, locale, settings.durationFormat),
    currency: settings.currency,
  });
}

export function GeneralSection({
  settings,
  onSave,
}: GeneralSectionProps): JSX.Element {
  const t = useT("popup");
  const locale = usePopupLocale();
  if (settings === null) {
    return <p className="loading">{t("settings.loading")}</p>;
  }

  // A currency the workspace already uses but that is not in the curated list
  // must still be selectable, or the <select> would silently drop it — and
  // picking any other option would then be the only way to leave the field.
  const currencies = CURRENCIES.includes(settings.currency)
    ? CURRENCIES
    : [settings.currency, ...CURRENCIES];

  const workspaceNote = t("general.workspaceNote");

  return (
    <>
      <SettingRow
        label={t("general.language")}
        htmlFor="setting-language"
        note={t("general.languageNote")}
        testId="setting-language"
      >
        <select
          id="setting-language"
          className="select"
          value={settings.locale}
          onChange={(event) => {
            // Not applied here, like the theme below: the popup follows
            // `state.settings.locale`, so a refused write leaves the language
            // where it really is.
            void onSave({ locale: event.target.value as LocalePreference });
          }}
          data-testid="language-select"
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {languageLabel(language, t)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.theme")}
        htmlFor="setting-theme"
        note={t("general.themeNote")}
        testId="setting-theme"
      >
        <select
          id="setting-theme"
          className="select"
          value={settings.theme}
          onChange={(event) => {
            // Not applied here: the popup follows `state.settings.theme`, so
            // the successful mutation's snapshot is what repaints it — and a
            // refusal therefore leaves the theme where it really is rather
            // than where the <select> briefly said it was.
            void onSave({ theme: event.target.value as ThemePreference });
          }}
          data-testid="theme-select"
        >
          {THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {themeLabel(theme, t)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.timeFormat")}
        htmlFor="setting-time-format"
        testId="setting-time-format"
      >
        <select
          id="setting-time-format"
          className="select"
          value={settings.timeFormat}
          onChange={(event) => {
            void onSave({ timeFormat: event.target.value as TimeFormat });
          }}
          data-testid="time-format-select"
        >
          {TIME_FORMATS.map((format) => (
            <option key={format} value={format}>
              {clockLabel(format, t)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.durationFormat")}
        htmlFor="setting-duration-format"
        note={t("general.durationFormatNote")}
        testId="setting-duration-format"
      >
        <select
          id="setting-duration-format"
          className="select"
          value={settings.durationFormat}
          onChange={(event) => {
            void onSave({
              durationFormat: event.target.value as DurationFormat,
            });
          }}
          data-testid="duration-format-select"
        >
          {DURATION_FORMATS.map((format) => (
            <option key={format} value={format}>
              {formatDurationFor(SAMPLE_DURATION_SEC, locale, format)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.weekStart")}
        htmlFor="setting-week-start"
        note={workspaceNote}
        testId="setting-week-start"
      >
        <select
          id="setting-week-start"
          className="select"
          value={settings.weekStartsOn === 0 ? "0" : "1"}
          onChange={(event) => {
            // Sent as a number: the schema is a union of the literals 0 and 1,
            // and rejects the string an <option> value always is.
            const weekStartsOn: WeekStart = event.target.value === "0" ? 0 : 1;
            void onSave({ weekStartsOn });
          }}
          data-testid="week-start-select"
        >
          {WEEK_STARTS.map((day) => (
            <option key={day} value={String(day)}>
              {formatWeekday(day, locale)}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.currency")}
        htmlFor="setting-currency"
        note={workspaceNote}
        testId="setting-currency"
      >
        <select
          id="setting-currency"
          className="select"
          value={settings.currency}
          onChange={(event) => {
            // Uppercased here because this schema's regex is /^[A-Z]{3}$/ and,
            // unlike `currencyCodeSchema`, does not transform for you.
            void onSave({ currency: event.target.value.toUpperCase() });
          }}
          data-testid="currency-select"
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {t("general.currencyOption", { code, name: currencyName(code, locale) })}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("general.defaultRate")}
        htmlFor="setting-default-rate"
        note={t("general.defaultRateNote")}
        testId="setting-default-rate"
      >
        <NumberField
          id="setting-default-rate"
          value={settings.defaultHourlyRate}
          onCommit={(defaultHourlyRate) => {
            void onSave({ defaultHourlyRate });
          }}
          min={0}
          max={1_000_000}
          step={0.01}
          suffix={settings.currency}
          ariaLabel={t("general.defaultRate")}
          testId="default-hourly-rate"
        />
      </SettingRow>
    </>
  );
}
