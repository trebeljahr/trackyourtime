/**
 * Every catalog, assembled. The ONLY file that lists namespaces — adding one
 * means a file in en/ and de/ and a line in each object below.
 *
 * Both locales are bundled statically. A German user must never wait on a
 * chunk before the first German paint (the pre-paint gate is holding the page
 * hidden meanwhile), and the whole catalog is small next to one chart library.
 */
import type { Translation } from "@starter/shared";

import { common as en_common } from "./en/common";
import { tracker as en_tracker } from "./en/tracker";
import { calendar as en_calendar } from "./en/calendar";
import { reports as en_reports } from "./en/reports";
import { catalog as en_catalog } from "./en/catalog";
import { settings as en_settings } from "./en/settings";
import { shell as en_shell } from "./en/shell";
import { marketing as en_marketing } from "./en/marketing";
import { common as de_common } from "./de/common";
import { tracker as de_tracker } from "./de/tracker";
import { calendar as de_calendar } from "./de/calendar";
import { reports as de_reports } from "./de/reports";
import { catalog as de_catalog } from "./de/catalog";
import { settings as de_settings } from "./de/settings";
import { shell as de_shell } from "./de/shell";
import { marketing as de_marketing } from "./de/marketing";

/** The source catalog. Its literal types drive key and argument checking. */
export const en = {
  common: en_common,
  tracker: en_tracker,
  calendar: en_calendar,
  reports: en_reports,
  catalog: en_catalog,
  settings: en_settings,
  shell: en_shell,
  marketing: en_marketing,
} as const;

export type Messages = typeof en;
export type Namespace = keyof Messages;

/** Typed against `en`: a missing, misspelled or extra key fails `tsc`. */
export const de: Translation<Messages> = {
  common: de_common,
  tracker: de_tracker,
  calendar: de_calendar,
  reports: de_reports,
  catalog: de_catalog,
  settings: de_settings,
  shell: de_shell,
  marketing: de_marketing,
};

export const NAMESPACES = Object.keys(en) as Namespace[];
