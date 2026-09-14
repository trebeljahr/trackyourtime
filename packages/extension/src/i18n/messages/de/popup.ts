import type { Translation } from "@starter/shared";

import type { popup as source } from "../en/popup";

/** German `popup`. Terms follow packages/client/src/i18n/GLOSSARY.de.md; voice is „du“. */
export const popup: Translation<typeof source> = {
  workspace: {
    label: "Arbeitsbereich",
    heldTitle: "{count, plural, one {# Änderung} other {# Änderungen}} nicht gesendet",
    heldHint: "In einem Arbeitsbereich in die Warteschlange gestellt, zu dem dein Konto nicht mehr gehört. Sie werden an keinen anderen Arbeitsbereich gesendet. Bitte einen Inhaber, dich wieder hinzuzufügen, um sie zu synchronisieren, oder verwirf sie hier.",
    leftWorkspace: "einen verlassenen Arbeitsbereich",
    untitled: "(ohne Beschreibung)",
    discard: "Verwerfen",
    discardHint: "Damit löschst du in {workspace} erfasste Arbeit, die kein Server erhalten hat. Sie lässt sich nicht wiederherstellen.",
    ops: {
      start: "„{description}“ in {workspace} starten",
      stop: "In {workspace} stoppen",
      create: "„{description}“ in {workspace} hinzufügen",
      update: "„{description}“ in {workspace} bearbeiten",
      remove: "Einen Eintrag in {workspace} löschen",
      other: "Eine Änderung in {workspace}",
    },
  },
};
