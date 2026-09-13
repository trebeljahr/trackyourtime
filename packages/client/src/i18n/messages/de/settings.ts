import type { Translation } from "@starter/shared";

import type { settings as source } from "../en/settings";

/** German `settings`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const settings: Translation<typeof source> = {
  language: {
    title: "Sprache",
    description: "Wird in deinem Konto gespeichert. „System“ folgt der Sprache des jeweiligen Geräts.",
    system: "System",
    en: "English",
    de: "Deutsch",
    pseudo: "Pseudo (nur Entwicklung)",
  },
};
