import type { Translation } from "@starter/shared";

import type { shell as source } from "../en/shell";

/** German `shell`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const shell: Translation<typeof source> = {
  theme: {
    change: "Design ändern",
    light: "Hell",
    dark: "Dunkel",
    system: "System",
  },
};
