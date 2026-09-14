/**
 * English `email` — the SOURCE catalog for transactional email (services/email.ts): subjects and bodies of password reset, invitations and the like.
 *
 * Add keys here, then the same keys in ../de/email.ts (`tsc` enforces it). ICU
 * syntax as in the web client. Server text is rendered in a locale decided by
 * the DOCUMENT (an invoice's snapshotted `locale`, an email recipient's stored
 * preference), never by the request that happens to trigger it.
 *
 * Each email is a few whole sentences, one per key, and
 * `services/transactional-email.ts` lays them out as paragraphs — so a
 * translation never has to fit words around HTML, and arguments are escaped
 * once, in code, rather than trusted inside a message.
 */
export const email = {
  passwordReset: {
    subject: "Reset your password",
    intro: "Open this link to reset your Track Your Time password:",
    action: "Reset your password",
    ignore: "If you did not ask to reset your password, ignore this email. Your password stays the same.",
  },
  verification: {
    subject: "Verify your email",
    intro: "Open this link to confirm that this address belongs to your Track Your Time account:",
    action: "Verify your email",
    ignore: "If you did not create an account, ignore this email.",
  },
  invitation: {
    subject: "{inviter} invited you to {workspace} on Track Your Time",
    intro: "{inviter} invited you to join {workspace} on Track Your Time.",
    action: "Accept the invitation",
    expiry: "The link works for {hours} hours. If you did not expect this email, ignore it.",
    someone: "Someone",
    aWorkspace: "a workspace",
  },
  newsletterConfirmation: {
    subject: "Confirm your subscription · {siteName}",
    heading: "Confirm your subscription",
    lead: "You're one click away from {siteName}.",
    body: "Tap the button below to verify this address and finish signing up. The link is good for {days, plural, one {# day} other {# days}}.",
    action: "Confirm my subscription",
    pasteUrl: "Or paste this URL into your browser:",
    ignore: "If you didn't sign up, ignore this email — no list membership is created until you click. The link expires in {days, plural, one {# day} other {# days}}.",
    /** Stands in for `siteName` when the instance has not named its newsletter. */
    defaultSiteName: "this newsletter",
  },
  /** The once-per-timer reminder from services/scheduler/runaway-reminder.ts. */
  runawayReminder: {
    /** `elapsed` and `limit` are durations already formatted, e.g. "9 h 12 min". */
    subject: "Your timer has been running for {elapsed}",
    startedText: "Your timer \"{name}\" started at {started} and has run for {elapsed}.",
    /** The HTML body sets `name` in bold, so it carries no quotes of its own. */
    startedHtml: "Your timer {name} started at {started} and has run for {elapsed}.",
    untitled: "Untitled",
    forgot: "If you forgot to stop it, stop it now or correct its end time.",
    pastLimit: "That is past your {limit} limit. Stop it, keep it running, or correct its end time.",
    open: "Open the tracker",
    footer: "You get this email once per timer. To stop these emails, turn off Email notifications in Settings, Account.",
  },
} as const;
