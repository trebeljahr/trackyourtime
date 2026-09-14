import type { Translation } from "@starter/shared";

import type { members as source } from "../en/members";

/** German `members`. Terms follow i18n/GLOSSARY.de.md; voice is „du“. */
export const members: Translation<typeof source> = {
  page: {
    title: "Mitglieder",
    description: "Wer in {workspace} arbeitet und was jede Person sehen kann.",
    loadError: "Die Mitglieder dieses Arbeitsbereichs konnten nicht geladen werden.",
  },
  roles: {
    owner: "Inhaber",
    admin: "Admin",
    member: "Mitglied",
  },
  table: {
    name: "Name",
    email: "E-Mail",
    role: "Rolle",
    time: "Sieht Zeit anderer",
    money: "Sieht Beträge anderer",
    joined: "Beigetreten",
    actions: "Aktionen",
    you: "Du",
    roleOf: "Rolle von {name}",
    timeOf: "{name} kann die Zeit anderer sehen",
    moneyOf: "{name} kann die Beträge anderer sehen",
    ownerSeesAll: "Inhaber sehen immer die Zeit und die Beträge aller.",
    remove: "Entfernen",
    makeOwner: "Zum Inhaber machen",
  },
  confirmRemove: {
    title: "{name} entfernen?",
    description:
      "{name} kann diesen Arbeitsbereich nicht mehr öffnen. Ein hier laufender Timer wird gestoppt. Die erfasste Zeit bleibt im Arbeitsbereich.",
    confirm: "Mitglied entfernen",
  },
  confirmTransfer: {
    title: "{name} zum Inhaber machen?",
    description:
      "{name} wird Inhaber dieses Arbeitsbereichs. Du wirst Admin, und nur der neue Inhaber kann dich wieder zum Inhaber machen.",
    confirm: "Inhaberschaft übertragen",
  },
  leave: {
    title: "Diesen Arbeitsbereich verlassen",
    description: "Du siehst diesen Arbeitsbereich und seine Zeit auf keinem Gerät mehr.",
    button: "Arbeitsbereich verlassen",
    confirmTitle: "{workspace} verlassen?",
    confirmDescription:
      "Du verlierst den Zugriff auf diesen Arbeitsbereich. Ein hier laufender Timer wird gestoppt. Um zurückzukommen, muss dich jemand erneut einladen.",
    confirm: "Verlassen",
    blockedLastOwner:
      "Übertrage zuerst die Inhaberschaft. Du bist der einzige Inhaber, und die anderen Mitglieder brauchen einen.",
    blockedOnlyMember:
      "Du bist das einzige Mitglied, es gibt also niemanden, dem du den Arbeitsbereich überlassen kannst.",
  },
  invite: {
    title: "Jemanden einladen",
    description:
      "Der Einladungslink funktioniert für die eingegebene E-Mail-Adresse und für kein anderes Konto.",
    email: "E-Mail-Adresse",
    role: "Rolle",
    submit: "Einladung senden",
    sending: "Wird gesendet …",
    sent: "Einladung an {email} gesendet.",
    noEmail:
      "Auf diesem Server ist kein E-Mail-Versand eingerichtet. Schick diesen Link selbst an {email}.",
    link: "Einladungslink",
    copyFailed: "Der Link konnte nicht kopiert werden. Markiere ihn und kopiere ihn von Hand.",
    adminHint: "Admins können Mitglieder einladen und entfernen.",
    memberHint:
      "Mitglieder sehen nur ihre eigene Zeit, bis ein Inhaber oder Admin das ändert.",
  },
  pending: {
    title: "Offene Einladungen",
    empty: "Keine Einladung wartet auf eine Antwort.",
    details:
      "{role, select, admin {Admin} other {Mitglied}} · eingeladen von {inviter} · läuft ab am {date}",
    copyLink: "Link kopieren",
    cancel: "Einladung zurückziehen",
    cancelOf: "Einladung für {email} zurückziehen",
    canceled: "Einladung für {email} zurückgezogen.",
  },
  toasts: {
    roleChanged:
      "{role, select, admin {{name} ist jetzt Admin.} other {{name} ist jetzt Mitglied.}}",
    visibilitySaved: "Sichtbarkeit für {name} gespeichert.",
    removed: "{name} wurde aus dem Arbeitsbereich entfernt.",
    transferred: "{name} ist jetzt Inhaber.",
  },
  errors: {
    ownerRequired: "Das kann nur ein Inhaber.",
    adminRequired: "Das kann nur ein Inhaber oder Admin.",
    cannotModifySelf: "Deine eigene Rolle und Sichtbarkeit kannst du nicht ändern.",
    cannotModifyOwner: "Einen Inhaber kann nur ein anderer Inhaber ändern.",
    transferOwnershipFirst:
      "Übertrage zuerst die Inhaberschaft. Der Arbeitsbereich braucht einen Inhaber.",
    workspaceHasNoOtherMembers: "Du bist das einzige Mitglied dieses Arbeitsbereichs.",
    alreadyMember: "Diese Person ist schon Mitglied des Arbeitsbereichs.",
    invitationEmailMismatch: "Diese Einladung gilt für eine andere E-Mail-Adresse.",
    invitationNotPending: "Diese Einladung kann nicht mehr angenommen werden.",
    inviteLimitReached:
      "Zu viele Einladungen warten auf eine Antwort. Ziehe einige zurück oder versuch es später.",
    invoicePermissionRequired:
      "Rechnungen brauchen einen Inhaber oder Admin, der die Zeit und die Beträge aller sehen kann.",
    notFound: "Dieses Mitglied oder diese Einladung gibt es nicht mehr. Die Liste wird neu geladen.",
  },
  workspaceTab: {
    title: "Arbeitsbereich",
    description: "Der Arbeitsbereich, in dem diese App gerade arbeitet.",
    name: "Name",
    yourRole: "Deine Rolle",
    count: "{count, plural, one {# Mitglied} other {# Mitglieder}}",
    manage: "Mitglieder verwalten",
    view: "Mitglieder ansehen",
    loadError: "Dein Arbeitsbereich konnte nicht geladen werden.",
  },
  invitePage: {
    title: "Einladung",
    loading: "Einladung wird geladen …",
    headline:
      "{inviter} hat {email} als {role, select, admin {Admin} other {Mitglied}} in {workspace} eingeladen.",
    signedOutHint: "Melde dich mit {email} an oder registriere dich, um anzunehmen.",
    signIn: "Anmelden",
    createAccount: "Konto erstellen",
    accept: "Einladung annehmen",
    accepting: "Wird beigetreten …",
    decline: "Ablehnen",
    declined: "Du hast die Einladung abgelehnt. Du kannst diese Seite schließen.",
    mismatchTitle: "Diese Einladung gilt für {email}",
    mismatchBody:
      "Du bist als {current} angemeldet. Melde dich ab und mit {email} wieder an, um sie anzunehmen.",
    switchAccount: "Abmelden und Konto wechseln",
    openApp: "Track Your Time öffnen",
    loadError:
      "Die Einladung konnte nicht geladen werden. Prüfe deine Verbindung und versuch es noch einmal.",
    expiredTitle: "Diese Einladung ist abgelaufen",
    expiredBody: "Bitte {inviter}, dir eine neue zu schicken.",
    canceledTitle: "Diese Einladung wurde zurückgezogen",
    canceledBody: "Frag {inviter}, wenn du noch Zugriff auf {workspace} brauchst.",
    acceptedTitle: "Diese Einladung wurde schon angenommen",
    acceptedBody: "Öffne die App, um Zeit in {workspace} zu erfassen.",
    rejectedTitle: "Diese Einladung wurde abgelehnt",
    rejectedBody: "Bitte {inviter} um eine neue, falls das ein Versehen war.",
    notFoundTitle: "Einladung nicht gefunden",
    notFoundBody: "Der Link ist vielleicht unvollständig, oder die Einladung wurde gelöscht.",
  },
  reports: {
    members: "Mitglieder",
    empty: "Keine Mitglieder.",
    search: "Mitglieder suchen …",
    groupBy: "Mitglied",
    moneyHidden: "Beträge sind für deine Rolle ausgeblendet.",
  },
};
