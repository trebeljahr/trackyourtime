/**
 * Client/server compatibility: the API level and the version handshake.
 *
 * Three clocks run at once. A self-hosted server can lag months behind; the
 * store clients (extension, Raycast, the phone apps) update themselves and are
 * often NEWER than the server they talk to; a desktop build or a tab left open
 * is often OLDER. A release number cannot say whether two of them understand
 * each other, because a server and a client of the same release were never
 * guaranteed to be deployed together.
 *
 * So each side declares an integer **API level** — the set of tRPC
 * procedures, input fields, enum values and sync event kinds it knows — and
 * each side names the lowest level of the other it still works with. The
 * rule for bumping it, and the header contract, are in docs/versioning.md.
 */

/**
 * The API level this build speaks.
 *
 * Bump it (and add a row to {@link API_LEVEL_CHANGES}) whenever a tRPC
 * procedure, an input field, an enum value or a sync event kind is ADDED.
 * Never lower it. A server reports it on `/api/health` and `health.check`; a
 * client sends it on every request as {@link API_LEVEL_HEADER}.
 */
export const API_LEVEL = 43;

export type ApiLevelChange = {
  level: number;
  /** The release the level first shipped in. */
  release: string;
  /** What a peer at this level can rely on that one below cannot. */
  added: readonly string[];
};

/**
 * What each level added, oldest first. The last row's `level` is
 * {@link API_LEVEL}; `version-handshake.test.ts` in the server tests checks that.
 *
 * Level 0 is not a row: it is every server and client released before the
 * handshake existed, which sends no level at all and reports none.
 */
export const API_LEVEL_CHANGES: readonly ApiLevelChange[] = [
  {
    level: 1,
    release: "0.1.0",
    added: [
      "The version handshake: `x-trackyourtime-client-version` and `x-trackyourtime-api-level` request headers.",
      "`apiLevel`, `minClientApiLevel` and `commit` on `/api/health` and `health.check`.",
      "`clientVersion` and `apiLevel` on `devices.list` rows.",
      "The `CLIENT_TOO_OLD` refusal (`data.versionRefusal` on tRPC, `problems/client-too-old` on REST).",
    ],
  },
  {
    level: 2,
    release: "0.1.0",
    added: [
      "`settings.updateNotice`: the newest release, for owners and admins of a server with `TRACKYOURTIME_UPDATE_CHECK` on.",
    ],
  },
  {
    level: 3,
    release: "0.1.0",
    added: [
      "`color` on tasks: on every task row, and as an optional input to `tasks.create` and `tasks.update` (and REST `POST`/`PATCH /tasks`).",
      "`entryCount` on `tasks.list` and `tasks.get` rows, beside `totalSec`.",
      "Tasks no longer carry `done`; a server at this level strips it from an update rather than refusing it.",
    ],
  },
  {
    level: 4,
    release: "0.1.0",
    added: [
      "`profile.setAvatar` and `profile.removeAvatar`: a profile picture, stored by the server and served at `/api/avatars/<userId>/<key>`, which `user.image` on the session points at.",
    ],
  },
  {
    level: 5,
    release: "0.1.0",
    added: [
      "`invoices.update`: edit a draft's number, dates, notes, language, VAT and lines, guarded by `updatedAt`.",
      "Manual lines: `lines` on `invoices.preview` and `invoices.create`; `kind`, `quantity`, `unit` and `unitPrice` on invoice line rows.",
      "Blank invoices: `from` and `to` are optional on `invoices.preview` and `invoices.create`, and `null` on the invoice row.",
    ],
  },
  {
    level: 6,
    release: "0.1.0",
    added: [
      "`settings.setBusinessLogo` and `settings.clearBusinessLogo`: the PNG or JPEG printed top right of every new invoice.",
      "`logo` on `settings.businessProfile` (a data URL with its pixel size, or null).",
      "`hasLogo` on an invoice's `issuer` when the invoice carries the logo frozen at its creation.",
    ],
  },
  {
    level: 7,
    release: "0.2.0",
    added: [
      "Independent clientId on time entries and favorites, including filtering, reporting and invoicing.",
    ],
  },
  {
    level: 8,
    release: "0.2.0",
    added: [
      "Optional start time on entries.resolveRunaway when setting the real end time.",
    ],
  },
  { level: 9, release: "0.3.0", added: ["Invoice payment ledger, full credit/correction, reminders and overdue filter."] },
  {
    level: 10,
    release: "0.3.0",
    added: ["entries.bulkEdit: bounded, revision-checked entry edits with per-entry outcomes."],
  },
  { level: 11, release: "0.3.0", added: [
    "Member rate editing and author-specific billing defaults.",
    "Optional transactional timesheet submission, review and period locks; approval eligibility for invoices.",
  ] },
  { level: 12, release: "0.3.0", added: ["entries.applyOperation with transactional receipts and a database capability handshake."] },
  {
    level: 13,
    release: "0.3.0",
    added: [
      "`workspaces.create`: a new team workspace (name, currency, week start) owned by the caller.",
      "`kind` (`personal` | `team`) on `workspaces.list` rows; a personal workspace cannot be left, transferred or invited into.",
    ],
  },
  {
    level: 14,
    release: "0.4.0",
    added: [
      "`POST /api/reports/export`: report CSV and PDF files streamed as they are produced, with the input of `reports.exportPdf` plus `format`.",
    ],
  },
  {
    level: 15,
    release: "0.4.0",
    added: [
      "`maxDuration.emailReminder` on `settings.get` and `settings.update`: the forgotten-timer email, off unless the person turns it on. `Profile.preferences.notifications` no longer controls it.",
    ],
  },
  { level: 16, release: "0.4.0", added: [
    "Lightweight projects.options, clients.options and tasks.options; independent tasks.projectLinks.",
    "reports.rows and reports.totals: paginated entries independent of full-range totals.",
  ] },
  {
    level: 17,
    release: "0.4.0",
    added: [
      "`hidden` on tag rows, `tags.create` and `tags.update`; `includeHidden` on `tags.list` (also REST and MCP). Hidden automation tags are omitted from normal catalogs and report group labels.",
    ],
  },
  {
    level: 18,
    release: "0.4.0",
    added: [
      "Passkey sign-in and private identity enrollment with signed key updates under `privacy.*`.",
      "Encrypted workspace transport and migration preparation endpoints; workspace conversion remains disabled until client compatibility and restore validation are complete.",
    ],
  },
  { level: 19, release: "0.4.0", added: [
    "Private device unlocking through an encrypted relay: privacy.createDeviceUnlock, deviceUnlockStatus, approveDeviceUnlock and cancelDeviceUnlock.",
  ] },
  { level: 20, release: "0.4.0", added: [
    "Signed encrypted workspace edits and immutable revision feeds under privacy.signedWrite and privacy.changes; both remain behind the workspace rollout guard.",
  ] },
  { level: 21, release: "0.4.0", added: [
    "Account-scoped deletion previews distinguish encrypted and standard shared-workspace retention policies under privacy.deletionPreview.",
  ] },
  { level: 22, release: "0.4.0", added: [
    "Owner-signed workspace key directory history and guarded preparation under privacy.directory and privacy.prepareDirectory; recipient metadata includes signing public keys. New private-key enrollments can bind their intended account and server.",
  ] },
  { level: 23, release: "0.4.0", added: [
    "Guarded reader-specific initial snapshot manifests and immutable ciphertext pages under privacy.initialSnapshot and privacy.initialSnapshotPage.",
  ] },
  { level: 24, release: "0.4.0", added: [
    "Guarded chained workspace edits and history under privacy.chainedWrite and privacy.chainedChanges. Initial snapshot v2 binds every reader to a common history root; private workspaces require the chained protocol without changing standard-client compatibility.",
  ] },
  { level: 25, release: "0.4.0", added: [
    "Guarded member-private favorites source and signed conversion acknowledgements under privacy.migrationFavoritesSource and privacy.acknowledgeMigrationFavorites; no conversion or plaintext deletion is enabled.",
  ] },
  { level: 26, release: "0.4.0", added: ["Guarded owner migration approval bound to a reopened encrypted original backup and exact signed initial snapshot; no source deletion is enabled."] },
  { level: 27, release: "0.4.0", added: ["Encrypted members records separate shared member details from private hourly rates. Guarded private snapshot consumers require this kind; standard-client compatibility is unchanged."] },
  { level: 28, release: "0.4.0", added: ["Encrypted workspaceIdentity and creator-only integrations kinds for lossless supplemental recovery. Private snapshots require the expanded kind set; no migration or source deletion is enabled."] },
  { level: 29, release: "0.4.0", added: ["Context-bound record keyCommitment for multi-reader ciphertext; initial private snapshots require the extended record format. Workspace migration remains disabled."] },
  {
    level: 30,
    release: "0.4.0",
    added: ["`privacy.recoveryChallenge` and `privacy.combinedRecovery`: trusted-root, session-bound original backups for standard owner workspaces, including the supplemental dataset."],
  },
  { level: 31, release: "0.4.0", added: ["`privacy.inventoryWrite` and `privacy.inventoryVersions`: root-signed encrypted account workspace inventory history, with immutable retries and bounded pages. Workspace conversion remains disabled."] },
  { level: 32, release: "0.4.0", added: ["Authenticated POST reader projections and directory history for trusted private workspace bootstrap, including permanent reserved mode. Conversion and private content writes remain disabled."] },
  { level: 33, release: "0.4.0", added: ["Read-only profile.displayPreferences for account rendering/idle preferences without plaintext workspace rates or currency. Private workspace conversion and writes remain disabled."] },
  { level: 34, release: "0.4.0", added: ["Read-only profile.workspaceMemberMetadata for existing account names, emails and membership ids without workspace rates or authority. Private conversion and writes remain disabled."] },
  { level: 35, release: "0.4.0", added: ["Optional clientWorkspaceId on workspaces.create binds standard workspace creation to a client-generated UUID. Private conversion and writes remain disabled."] },
  { level: 36, release: "0.4.0", added: ["Authenticated privacy.timerVersions and guarded privacy.timerWrite coordinate signed account timer history with encrypted workspace edits. Conversion and private content writes remain disabled."] },
  { level: 37, release: "0.4.0", added: ["Optional signed standardStart coordinates and transient standardStartInput extend guarded account timer writes for atomic private-to-standard handoffs. Conversion and private content writes remain disabled."] },
  { level: 38, release: "0.4.0", added: ["Account-scoped privacy.standardCurrentTimer checks the actual timer workspace and membership before returning standard time, independent of workspace selection. Private timers remain client-only; conversion and private content writes remain disabled."] },
  { level: 39, release: "0.4.0", added: ["Encrypted author-owned entryoperations receipts may accompany guarded account timer transitions, bound to the signed operation UUID. Public conversion and private content writes remain disabled."] },
  { level: 40, release: "0.4.0", added: ["Account-scoped privacy.standardTimerResult reads the original standard result of a previously committed private timer handoff, with fresh membership/mode and original request checks. It cannot start or reopen time. Private rollout guards remain closed."] },
  { level: 41, release: "0.4.0", added: ["Authenticated privacy.standardContinueTimerInput prepares a standard continuation without changing time, with fresh workspace membership and visibility. Private handoff receipts retain the original continuation recipe. Private rollout guards remain closed."] },
  { level: 42, release: "0.4.0", added: ["Password unlock: public accountPassword.kdf answers an email's password KDF parameters (decoys for unknown emails), accountPassword.kdfForReset answers them for a valid reset link; sign-up accepts passwordKdf; authenticated accountPassword.upgrade switches a legacy typed password to the derived login secret."] },
  { level: 43, release: "0.4.0", added: ["Password unlock repair: a password reset flags the account keys' password envelope as stale; authenticated accountPassword.keysStatus reads the flag, accountPassword.verify checks a derived login secret (10 per 15 minutes), accountPassword.keysRewrapped clears the flag."] },
];

/**
 * The lowest client API level this server still serves.
 *
 * A request that DECLARES a lower level is refused with {@link CLIENT_TOO_OLD}.
 * A request that declares nothing is a client from before the handshake and is
 * served as before — raising this floor never locks those out silently; that
 * would need a separate decision.
 */
export const MIN_CLIENT_API_LEVEL = 1;

/** The app release of the client making the request, e.g. `0.3.1`. */
export const CLIENT_VERSION_HEADER = "x-trackyourtime-client-version";

/** The {@link API_LEVEL} the client making the request was built with. */
export const API_LEVEL_HEADER = "x-trackyourtime-api-level";

/** The server refused a client whose declared API level is below its floor. */
export const CLIENT_TOO_OLD = "CLIENT_TOO_OLD";

/** The client refuses a server whose API level is below its own floor. */
export const SERVER_TOO_OLD = "SERVER_TOO_OLD";

export type VersionRefusal = typeof CLIENT_TOO_OLD | typeof SERVER_TOO_OLD;

/** Longest client version string a server stores. Anything longer is noise. */
const MAX_VERSION_LENGTH = 64;

const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A client version as a server may record it, or null.
 *
 * Self-reported and therefore cosmetic: it names a row in Settings → Devices
 * and is never a permission.
 */
export const parseClientVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
};

/**
 * A declared API level, or null when the request declared none.
 *
 * Null covers a malformed value too. A header nobody can read is treated like
 * a missing one — a legacy client — rather than as level 0, so a proxy that
 * mangles headers cannot get a working client refused.
 */
export const parseApiLevel = (value: unknown): number | null => {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
};

/**
 * Compare two release strings numerically, major.minor.patch.
 *
 * A prerelease sorts before its release (`1.2.0-rc.1` < `1.2.0`); two
 * prereleases of one release compare as equal, which is all the callers need.
 * Unparseable input compares as equal to anything, so it never wins.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string): { core: number[]; pre: boolean } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?/.exec(value.trim());
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] !== undefined,
    };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
};

/**
 * The two handshake headers, for a client to spread into every API request.
 *
 * Never send these to `/api/health` on a server that has not said it trusts
 * the caller's origin: a custom header makes a browser preflight the request,
 * and an untrusted origin's preflight fails — turning "reachable, but not
 * trusting you" into "unreachable".
 */
export const versionHeaders = (clientVersion: string | null | undefined): Record<string, string> => {
  const headers: Record<string, string> = { [API_LEVEL_HEADER]: String(API_LEVEL) };
  const version = parseClientVersion(clientVersion);
  if (version !== null) headers[CLIENT_VERSION_HEADER] = version;
  return headers;
};
