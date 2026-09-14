/**
 * English `members` messages — the SOURCE catalog for workspace membership:
 * the Members screen, invitations (sending them and the public /invite page),
 * the Settings → Workspace tab, and the member filter in Reports.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/members.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const members = {
  page: {
    title: "Members",
    description: "Who works in {workspace}, and what each person can see.",
    loadError: "Could not load the members of this workspace.",
  },
  roles: {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  },
  table: {
    name: "Name",
    email: "Email",
    role: "Role",
    time: "Sees colleagues' time",
    money: "Sees colleagues' money",
    joined: "Joined",
    actions: "Actions",
    you: "You",
    roleOf: "Role of {name}",
    timeOf: "{name} can see colleagues' time",
    moneyOf: "{name} can see colleagues' money",
    ownerSeesAll: "Owners always see everyone's time and money.",
    remove: "Remove",
    makeOwner: "Make owner",
  },
  confirmRemove: {
    title: "Remove {name}?",
    description:
      "{name} can no longer open this workspace. A timer they have running here stops. The time they tracked stays in the workspace.",
    confirm: "Remove member",
  },
  confirmTransfer: {
    title: "Make {name} the owner?",
    description:
      "{name} becomes the owner of this workspace. You become an admin, and only the new owner can make you owner again.",
    confirm: "Transfer ownership",
  },
  leave: {
    title: "Leave this workspace",
    description: "You stop seeing this workspace and its time on every device.",
    button: "Leave workspace",
    confirmTitle: "Leave {workspace}?",
    confirmDescription:
      "You lose access to this workspace. A timer you have running here stops. To come back, somebody has to invite you again.",
    confirm: "Leave",
    blockedLastOwner:
      "Transfer ownership first. You are the only owner, and the other members need one.",
    blockedOnlyMember: "You are the only member, so there is nobody to leave the workspace to.",
  },
  invite: {
    title: "Invite someone",
    description: "The invitation link works for the email address you enter, and for no other account.",
    email: "Email address",
    role: "Role",
    submit: "Send invitation",
    sending: "Sending…",
    sent: "Invitation sent to {email}.",
    noEmail: "Email is not set up on this server. Send this link to {email} yourself.",
    link: "Invitation link",
    copyFailed: "Could not copy the link. Select it and copy it by hand.",
    adminHint: "Admins can invite members and remove them.",
    memberHint: "Members see only their own time until an owner or admin changes that.",
  },
  pending: {
    title: "Pending invitations",
    empty: "No invitations are waiting for an answer.",
    details: "{role, select, admin {Admin} other {Member}} · invited by {inviter} · expires {date}",
    copyLink: "Copy link",
    cancel: "Cancel invitation",
    cancelOf: "Cancel the invitation for {email}",
    canceled: "Invitation for {email} canceled.",
  },
  toasts: {
    roleChanged: "{role, select, admin {{name} is now an admin.} other {{name} is now a member.}}",
    visibilitySaved: "Visibility for {name} saved.",
    removed: "{name} was removed from the workspace.",
    transferred: "{name} is now the owner.",
  },
  errors: {
    ownerRequired: "Only an owner can do this.",
    adminRequired: "Only an owner or an admin can do this.",
    cannotModifySelf: "You cannot change your own role or visibility.",
    cannotModifyOwner: "Only another owner can change an owner.",
    transferOwnershipFirst: "Transfer ownership first. The workspace needs an owner.",
    workspaceHasNoOtherMembers: "You are the only member of this workspace.",
    alreadyMember: "This person is already a member of the workspace.",
    invitationEmailMismatch: "This invitation is for a different email address.",
    invitationNotPending: "This invitation can no longer be accepted.",
    inviteLimitReached: "Too many invitations are waiting. Cancel some, or try again later.",
    invoicePermissionRequired: "Invoices need an owner or admin who can see everyone's time and money.",
    notFound: "This member or invitation no longer exists. The list is refreshed.",
  },
  workspaceTab: {
    title: "Workspace",
    description: "The workspace this app is working in.",
    name: "Name",
    yourRole: "Your role",
    count: "{count, plural, one {# member} other {# members}}",
    manage: "Manage members",
    view: "View members",
    loadError: "Could not load your workspace.",
  },
  invitePage: {
    title: "Invitation",
    loading: "Loading the invitation…",
    headline:
      "{inviter} invited {email} to {workspace} as {role, select, admin {an admin} other {a member}}.",
    signedOutHint: "Sign in or create an account with {email} to accept.",
    signIn: "Sign in",
    createAccount: "Create account",
    accept: "Accept invitation",
    accepting: "Joining…",
    decline: "Decline",
    declined: "You declined the invitation. You can close this page.",
    mismatchTitle: "This invitation is for {email}",
    mismatchBody: "You are signed in as {current}. Sign out, then sign in with {email} to accept it.",
    switchAccount: "Sign out and switch account",
    openApp: "Open Track Your Time",
    loadError: "Could not load the invitation. Check your connection and try again.",
    expiredTitle: "This invitation has expired",
    expiredBody: "Ask {inviter} to send a new one.",
    canceledTitle: "This invitation was canceled",
    canceledBody: "Ask {inviter} if you still need access to {workspace}.",
    acceptedTitle: "This invitation was already accepted",
    acceptedBody: "Open the app to track time in {workspace}.",
    rejectedTitle: "This invitation was declined",
    rejectedBody: "Ask {inviter} to send a new one if that was a mistake.",
    notFoundTitle: "Invitation not found",
    notFoundBody: "The link may be incomplete, or the invitation was deleted.",
  },
  reports: {
    members: "Members",
    empty: "No members.",
    search: "Search members...",
    moneyHidden: "Amounts are hidden for your role.",
  },
} as const;
