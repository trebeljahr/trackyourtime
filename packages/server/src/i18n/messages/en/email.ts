/**
 * English `email` — the SOURCE catalog for transactional email (services/email.ts): subjects and bodies of password reset, invitations and the like.
 *
 * Add keys here, then the same keys in ../de/email.ts (`tsc` enforces it). ICU
 * syntax as in the web client. Server text is rendered in a locale decided by
 * the DOCUMENT (an invoice's snapshotted `locale`, an email recipient's stored
 * preference), never by the request that happens to trigger it.
 */
export const email = {
  invitation: {
    subject: "{inviter} invited you to {workspace} on Track Your Time",
    intro: "{inviter} invited you to join {workspace} on Track Your Time.",
    action: "Accept the invitation",
    expiry: "The link works for {hours} hours. If you did not expect this email, ignore it.",
    someone: "Someone",
    aWorkspace: "a workspace",
  },
} as const;
