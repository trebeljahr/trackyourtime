import type {
  EinvoiceFill,
  ElectronicAddressScheme,
  InvoiceFormat,
  TaxBreakdownRow,
  TaxCategory,
} from "./einvoice.js";
import type { Locale, LocalePreference } from "./locale.js";

/** User theme preference. */
export type ThemePreference = "light" | "dark" | "system";

/** Shape of a user profile (extends better-auth's User). */
export type UserProfile = {
  userId: string;
  avatarUrl?: string;
  bio?: string;
  preferences: {
    theme: ThemePreference;
    notifications: boolean;
  };
};

// ── trackyourtime domain ─────────────────────────────────────────────────
//
// Every document is scoped by `workspaceId` — a better-auth organization id.
// Scope ("who may see this") and authorship ("who tracked this") are separate
// axes: `TimeEntry.authorId` is load-bearing, while the catalog's `createdBy`
// is audit only. All ids are strings and every timestamp crosses the wire as
// an ISO string — never a Date object.

/**
 * A workspace is one better-auth organization. Solo users get a personal
 * workspace at signup, so there is never a "no workspace" state and never a
 * solo-vs-team branch in a query.
 */
export type Workspace = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
};

/**
 * Roles come from better-auth's organization plugin. They gate *membership*
 * actions (invite, remove, delete). They deliberately do NOT gate what a
 * member can see — that is the two flags on WorkspaceMember, so that
 * "hours are transparent, rates are not" is representable.
 */
export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * App-owned membership record, sibling to better-auth's `member` collection.
 *
 * Business data (a billing rate, visibility) lives here rather than as
 * additional fields on the plugin's collection, so the plugin never becomes
 * the schema owner for money.
 */
export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  /** Display name, denormalized so reports can group by member without
   * reaching into better-auth's user collection mid-aggregation. */
  name: string;
  /**
   * Highest-priority rung of rate resolution, once Stage 7 wires it up.
   * Present and nullable from the first migration so there is never a second
   * one; until then the resolution stays project ?? workspace-default.
   */
  hourlyRate: number | null;
  /** May see other members' entries at all. */
  canViewOthersTime: boolean;
  /** May see other members' hourlyRate and amounts. Strictly narrower. */
  canViewOthersMoney: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * What one caller is allowed to see of one workspace, resolved once per
 * request and threaded into every report builder, the entry list and the
 * sync fan-out. Never re-derived at a call site.
 */
export type Visibility = {
  /** The caller — always fully visible to themselves. */
  userId: string;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
};

/**
 * Where a time entry was created. The browser extension is its own source
 * rather than folding into "api", so an entry can be traced back to the thing
 * that actually made it; "api" stays the catch-all for third-party callers.
 *
 * "import" is likewise its own source rather than "api": a backfilled entry
 * was never measured by a timer here, so a report that wants to say "tracked
 * with trackyourtime" and an undo that wants to remove only what a file brought in
 * both need to tell it apart from time this app watched tick by.
 */
export type EntrySource =
  | "web"
  | "desktop"
  | "mobile"
  | "extension"
  | "api"
  | "import";

/** How durations are rendered ("1:23:45" vs "1.40 h"). */
export type DurationFormat = "hms" | "decimal";

/** How clock times are rendered. */
export type TimeFormat = "12h" | "24h";

/** First day of the week — 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;

/** Dimensions a summary report can be grouped by. */
export type ReportGroupBy =
  | "project"
  | "client"
  | "task"
  /**
   * Tags are many-per-entry, so a tag-grouped summary is the one dimension
   * whose groups do NOT partition the entries: an entry carrying two tags
   * contributes its seconds to both groups, and an untagged entry lands in a
   * single "No tag" bucket. Group totals therefore sum to more than
   * `totalSec` — that is correct, not a bug, and the UI has to say so.
   */
  | "tag"
  /**
   * One group per AUTHOR. Only ever groups rows the caller may already see —
   * the author scope is applied to the match before any grouping — so a
   * member who may not see colleagues' time gets exactly one group: their own.
   */
  | "member"
  | "day"
  | "week"
  | "month";

/**
 * A cross-cutting label. Tags are deliberately OUTSIDE the
 * Client > Project > Task hierarchy: an entry belongs to exactly one place in
 * that tree, but can carry any number of tags ("billable-review", "on-site",
 * "bugfix"), which is what makes them useful for slicing across projects.
 */
export type Tag = {
  id: string;
  workspaceId: string;
  /** Audit only — never used for scoping. */
  createdBy: string;
  name: string;
  /** Hex color, e.g. "#4f46e5". */
  color: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * What a catalog `remove` reports back. Deletion always happens for clients,
 * projects and tasks; the counts describe the collateral so a client can say
 * what it cost rather than claiming a clean delete.
 *
 * Deleting a catalog row never deletes tracked time — an entry keeps its
 * start/end/duration and simply loses the reference.
 */
export type CatalogRemoveResult = {
  /** Time entries that kept their time but lost a project/task reference. */
  entriesDetached: number;
  /** Tasks deleted outright — only an import undo deletes a task. */
  tasksDeleted: number;
  /** Projects that kept their time but lost their client reference. */
  projectsDetached: number;
  /** Pinned quick starts that lost a project/task reference. */
  favoritesDetached: number;
};

/**
 * The time a project billing change can reach: the caller's own entries on
 * the project. Invoiced ones are counted apart because they are never
 * rewritten — an issued invoice was calculated from them.
 */
export type ProjectBillingImpact = {
  /** Entries a rewrite would touch. */
  entries: number;
  /** Entries on an invoice, which keep their billable flag and rate. */
  invoiced: number;
};

/** What `projects.update` reports about an `applyToEntries` rewrite. */
export type ProjectUpdateResult = Project & {
  /** Null when the update did not carry the change onto booked time. */
  entriesRewritten: ProjectBillingImpact | null;
};

/**
 * What removing a tag resolves to. A tag still on tracked time is archived
 * rather than deleted, so the caller has to be told which of the two happened.
 */
export type TagRemoveResult = {
  deleted: boolean;
  archived: boolean;
  /** Why it was archived instead, when that is what happened. */
  message: string | null;
};

/** A billable customer that projects belong to. */
export type Client = {
  id: string;
  workspaceId: string;
  /** Audit only — never used for scoping. */
  createdBy: string;
  name: string;
  /** Hex color, e.g. "#4f46e5". */
  color: string;
  archived: boolean;
  /**
   * The language this client's invoices are written in. Absent or null means
   * "no preference": the issuer's own language decides, see
   * `resolveInvoiceLocale`. Optional on the wire because every client written
   * before invoices were localised has no such field.
   */
  invoiceLocale?: Locale | null;
  /**
   * Who an invoice is addressed to. `null` for a client nobody has filled
   * in, which is every client created before billing details existed.
   */
  billing?: ClientBilling | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A client's billing identity — what an invoice prints under "Billed to".
 *
 * Every field is optional and a blank one is `null`, never `""`. A client
 * row predating this shape has no such subdocument at all, and must keep
 * loading, editing and exporting exactly as before.
 */
export type ClientBilling = {
  /** Registered name when it differs from the display name. */
  legalName: string | null;
  /** Street lines, in print order. Empty when unknown. */
  addressLines: string[];
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case, e.g. "DE". */
  country: string | null;
  /** VAT number or other tax id, as the customer states it. */
  taxId: string | null;
  email: string | null;
  /**
   * The customer's own reference — a purchase order, a cost centre. On an
   * e-invoice this is the buyer reference (BT-10), where a public-sector
   * customer's Leitweg-ID goes.
   */
  reference: string | null;
  /** VAT identification number (BT-48), compact and upper case. */
  vatId: string | null;
  /** Where e-invoices are delivered (BT-49). Both set or both null. */
  electronicAddress: string | null;
  electronicAddressScheme: ElectronicAddressScheme | null;
  /** How this client wants invoices; null means the plain PDF. Not snapshotted. */
  preferredFormat: InvoiceFormat | null;
  /** Default VAT category for new invoices, e.g. AE for an EU business. Not snapshotted. */
  defaultTaxCategory: TaxCategory | null;
};

/**
 * The workspace's own business identity: who issues its invoices, and how
 * they are to be paid. One per workspace, every field optional.
 */
export type BusinessProfile = {
  workspaceId: string;
  legalName: string | null;
  addressLines: string[];
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Free text: bank, IBAN, payment link — printed as written. */
  paymentDetails: string | null;
  /** Net days. Suggests an invoice's due date; `null` states no terms. */
  paymentTermsDays: number | null;
  /** A line printed at the bottom of every invoice. */
  invoiceFooter: string | null;
  /** VAT identification number (BT-31), compact and upper case. */
  vatId: string | null;
  /** National tax number, "Steuernummer" (BT-32). */
  taxNumber: string | null;
  /** Commercial register entry (BT-30). */
  registrationNumber: string | null;
  /** Any other seller identifier (BT-29). */
  sellerIdentifier: string | null;
  /** Contact person (BT-41). */
  contactName: string | null;
  /** Where e-invoices are sent from (BT-34). Both set or both null. */
  electronicAddress: string | null;
  electronicAddressScheme: ElectronicAddressScheme | null;
  /** BT-84, compact and upper case. */
  iban: string | null;
  /** BT-86, compact and upper case. */
  bic: string | null;
  bankName: string | null;
  /** BT-85. */
  accountHolder: string | null;
  /** Invoices without VAT under § 19 UStG. `false` when never set. */
  smallBusiness: boolean;
  /** The exemption text for a small business (BT-120 of category E). */
  smallBusinessNote: string | null;
  /** Default VAT category for new invoices. */
  defaultTaxCategory: TaxCategory | null;
  /** Default rate with category S; null or 0 otherwise. */
  defaultTaxRate: number | null;
  /** `null` until the profile has been saved once. */
  updatedAt: string | null;
};

/** A project that time is tracked against. */
export type Project = {
  id: string;
  workspaceId: string;
  /** Audit only — never used for scoping. */
  createdBy: string;
  name: string;
  /** Hex color, e.g. "#4f46e5". */
  color: string;
  clientId: string | null;
  billableDefault: boolean;
  /** Overrides `WorkspaceSettings.defaultHourlyRate` when set. */
  hourlyRate: number | null;
  /**
   * Lifetime hours the project is estimated at, e.g. 80 for "quoted at two
   * weeks". Null means no estimate — which is not the same as an estimate of
   * zero, and must never render as "0% of 0".
   */
  estimatedHours: number | null;
  /**
   * Lifetime money budget. Null means none was set. Recurring (per-month)
   * budgets are deliberately not modelled — see `budgets.ts`.
   */
  budgetAmount: number | null;
  /**
   * ISO 4217 code `budgetAmount` is denominated in, snapshotted from the
   * workspace currency when the budget was set. Null exactly when
   * `budgetAmount` is null.
   *
   * It is snapshotted for the same reason entries snapshot theirs: changing
   * the workspace currency later must not silently re-denominate a budget
   * that was agreed in the old one.
   */
  budgetCurrency: string | null;
  /**
   * Overrides `UserPreferences.idle.behavior` for entries on this project;
   * null inherits it. This is what "Meetings" and "Reading" are for — projects
   * where no keyboard input is the normal case, not a sign of absence.
   *
   * It never switches detection *on*: a workspace with idle disabled stays
   * disabled everywhere.
   */
  idleBehavior: IdleBehavior | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * A named unit of work, owned by the workspace rather than by a project.
 *
 * An entry carries a project and a task side by side; the task does not belong
 * to the project. "Design review" is the same kind of work whichever project it
 * happens on, so it stays one row instead of being re-created under each.
 */
export type Task = {
  id: string;
  workspaceId: string;
  /** Audit only — never used for scoping. */
  createdBy: string;
  name: string;
  done: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A tracked block of time. `end === null` means the timer is running. */
export type TimeEntry = {
  id: string;
  workspaceId: string;
  /**
   * Who tracked this. Load-bearing, unlike the catalog's `createdBy`: it is
   * the report grouping key, the money-visibility subject, and the key of the
   * one-running-timer index.
   */
  authorId: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  /** ISO datetime. */
  start: string;
  /** ISO datetime, or null while running. */
  end: string | null;
  /** 0 while running — derive live duration from `start` instead. */
  durationSec: number;
  /** Snapshot taken on stop/create so past earnings never shift. */
  hourlyRate: number | null;
  /** Snapshot of the workspace currency at stop/create time. */
  currency: string;
  source: EntrySource;
  /**
   * IANA zone the entry was recorded in, e.g. "Europe/Berlin".
   *
   * The instants are absolute, so durations never depend on this. It exists so
   * the clock time reads the same wherever the entry is later viewed or edited
   * from: an entry written at 23:30 in Berlin still says 23:30 when opened on a
   * laptop in Tokyo, instead of drifting by the offset between the two.
   *
   * Null on entries recorded before the field existed; callers fall back to the
   * viewer's own zone for those.
   */
  timeZone: string | null;
  /**
   * What the runaway-timer guard did about this entry, or null if it never
   * looked at it. See `runaway.ts` — it is kept after the fact on purpose, so
   * a cap can be seen, explained and put back.
   */
  runaway: RunawayMark | null;
  /** Ids of the {@link Tag}s on this entry. Empty array = untagged. */
  tagIds: string[];
  /**
   * The {@link Invoice} this entry has been billed on, or null while it is
   * still billable. See the note on the Mongoose field: `Invoice.entryIds` is
   * the source of truth and this is its denormalized index.
   */
  invoiceId: string | null;
  /**
   * The bulk import that created this entry, or null when a person tracked it
   * here. Null on every entry written before imports existed, which reads the
   * same way: nothing to undo as a batch.
   */
  importId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * What to do when a device notices the person at it has stopped giving input.
 *
 * `ask` is the default and the only behaviour that cannot lose time: the timer
 * keeps running until the answer arrives. The other three are opt-in, and two
 * of them shorten the running entry, which is exactly why they are a choice
 * rather than a threshold.
 */
export type IdleBehavior =
  /** Keep running and offer the choice — discard the idle span, or keep it. */
  | "ask"
  /** End the entry at the idle start, reopen an identical one on return. */
  | "pause-and-resume"
  /** Never act. For work that legitimately produces no input. */
  | "keep-running"
  /** End the entry at the idle start and stay stopped. */
  | "stop";

/**
 * Idle-detection configuration, nested inside a person's preferences.
 *
 * Detection is per-device; this is the shared policy every device applies to
 * its own signal. See `@starter/core/idle` for the rule that keeps one sleeping
 * laptop from pausing a timer the person is still driving from another machine.
 */
export type IdleSettings = {
  enabled: boolean;
  /** Minutes without input before the device considers the person away. */
  thresholdMinutes: number;
  behavior: IdleBehavior;
  /**
   * Treat a locked screen as away immediately, without waiting out the
   * threshold. Locking is deliberate in a way that "no keys pressed" is not.
   */
  lockIsImmediate: boolean;
};

/**
 * What to do about an entry that has been running longer than any single
 * sitting plausibly lasts.
 *
 * `ask` is the default and the only behaviour that cannot lose time. The
 * other two both close the entry, and they differ in what happens to the
 * overrun: `cap` throws it away, `stop` keeps all of it.
 *
 * There is no `keep-running` member, because `maxHours: 0` already says that
 * and one off-switch is enough.
 */
export type RunawayBehavior =
  /** Flag it and offer the choice. The timer keeps running until answered. */
  | "ask"
  /** End the entry at the maximum, discarding the overrun (recoverably). */
  | "cap"
  /** End the entry where it had got to, keeping every second. */
  | "stop";

/** What the guard actually did, recorded on the entry. */
export type RunawayAction = "flagged" | "capped" | "stopped";

/**
 * The guard's record of one intervention, kept on the entry itself.
 *
 * It exists so that no time is ever silently deleted: `start + elapsedSec`
 * reconstructs the exact span the guard measured, so a cap is always
 * reversible and always explainable. `resolvedAt` is set once the person has
 * answered the prompt; until then every client that shows the entry offers it.
 */
export type RunawayMark = {
  /** ISO datetime the guard evaluated and acted. */
  detectedAt: string;
  /** Seconds the entry had already been running when the guard noticed. */
  elapsedSec: number;
  /** The maximum in force at that moment, in seconds. */
  limitSec: number;
  action: RunawayAction;
  /** ISO datetime the person answered the prompt, or null while it stands. */
  resolvedAt: string | null;
};

/**
 * Runaway-guard configuration, and a sibling of {@link IdleSettings} in every
 * sense — including living on the person rather than on the workspace.
 *
 * That placement is load-bearing, not copied: the invariant is one running
 * timer per HUMAN across every workspace they belong to, so the entry the
 * guard acts on may be in any of them. A workspace-scoped maximum would mean
 * whichever workspace the timer happened to be started in decides how long a
 * person's day may be, and joining a workspace would silently change the rule.
 *
 * Evaluated on the server, not on a client — in the case this guard exists
 * for, no client is running. See `runaway.ts`.
 */
export type MaxDurationSettings = {
  /**
   * Hours one entry may run before the guard acts. `0` switches it off; the
   * UI's toggle writes 0 rather than carrying a second boolean.
   */
  maxHours: number;
  behavior: RunawayBehavior;
};

/**
 * Money and calendar config, shared by everyone in a workspace.
 *
 * `currency` in particular CANNOT be per-user: every entry snapshots it
 * (TimeEntry.currency) and a report carries exactly one currency for the whole
 * result, so two members with different personal currencies would make that
 * single field a lie.
 */
export type WorkspaceSettings = {
  workspaceId: string;
  defaultHourlyRate: number;
  /** ISO 4217 code, e.g. "EUR". */
  currency: string;
  weekStartsOn: WeekStart;
};

/**
 * Display preferences that belong to a person, not to a workspace.
 *
 * Idle detection lives here rather than on the workspace: how long a machine
 * sits before its owner counts as away, and what should happen then, is a fact
 * about that person's desk, not a policy their colleagues share. The runaway
 * guard sits beside it for a related reason — see {@link MaxDurationSettings}.
 */
export type UserPreferences = {
  userId: string;
  timeFormat: TimeFormat;
  durationFormat: DurationFormat;
  /**
   * Light, dark, or follow the operating system.
   *
   * A person's, not a device's. It used to live in the web app's
   * `localStorage` alone, which meant the browser extension rendering beside
   * that same web app had no way to know a dark theme had been chosen — every
   * client guessed from `prefers-color-scheme` and the two disagreed on any
   * machine where the choice was not the OS one. Storing it here is what lets
   * every surface render the same theme; each client still keeps a local copy
   * so it can paint before the first `settings.get` answers.
   */
  theme: ThemePreference;
  /**
   * The interface language, or "system" to follow the device.
   *
   * Stored with the theme, and for the same reason: the browser extension and
   * every other client signed in as this person should speak the same
   * language. "system" is resolved on each device against its own
   * `navigator.languages`, never on the server, which has no device to ask.
   */
  locale: LocalePreference;
  idle: IdleSettings;
  maxDuration: MaxDurationSettings;
};

/**
 * What `settings.get` returns: the two records above, merged.
 *
 * The storage split is the part that is expensive to change later, so it
 * happens now; the wire shape stays merged so no client has to change yet.
 * Splitting the procedure is a later, reversible step.
 */
export type ResolvedSettings = WorkspaceSettings & Omit<UserPreferences, "userId"> & {
  userId: string;
};

/**
 * Which trackyourtime client a session was created from. Set by the client
 * itself (`x-trackyourtime-client` header, or the device-flow `client_id`), so
 * treat it as a label, never as a permission.
 */
export type ClientKind =
  | "web"
  | "desktop"
  | "mobile"
  | "raycast"
  | "extension"
  | "cli"
  | "unknown";

/**
 * One signed-in device or app, as shown in Settings → Devices. This is a
 * projection of a better-auth session: the session token itself is secret and
 * never crosses the wire — `id` is what the revoke call takes.
 */
export type DeviceSession = {
  id: string;
  /** Human label, e.g. "Raycast on macOS" or "Chrome on macOS". */
  name: string;
  client: ClientKind;
  /** Raw user agent, kept for the "is this really me?" case. */
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  /** better-auth refreshes this as the session is used. */
  updatedAt: string;
  expiresAt: string;
  /** True for the session making the request — it cannot be revoked blindly. */
  current: boolean;
};

// ── invoicing ────────────────────────────────────────────────────────
//
// An invoice is a SNAPSHOT, not a view. Every number on it — the rate, the
// currency, the client's name, the seconds billed — is copied onto the
// document when it is created, so editing a project's rate or renaming a
// client afterwards never silently rewrites a document somebody has already
// sent to a customer.

/**
 * Lifecycle of an invoice. Deliberately three states and no more: "draft"
 * is still editable, "sent" has left the building, "paid" is done. Anything
 * finer (overdue, partially paid, void) is bookkeeping this app does not do.
 */
export type InvoiceStatus = "draft" | "sent" | "paid";

/** One billable line — a project or a task, rolled up over the range. */
export type InvoiceLineItem = {
  /** Stable identity within the invoice: the project/task id, or "none". */
  key: string;
  label: string;
  projectId: string | null;
  taskId: string | null;
  /** Exact billed seconds, so the invoice can be re-derived. */
  seconds: number;
  /** `seconds` as decimal hours, rounded the way the line is billed. */
  hours: number;
  /** Snapshot of the rate the line was billed at. */
  hourlyRate: number;
  currency: string;
  /** `hours × hourlyRate`, rounded to 2dp. */
  amount: number;
  /** Absent on invoices created before e-invoicing, until attachEinvoiceData fills it. */
  taxCategory?: TaxCategory;
  /** Percent. Present iff taxCategory is. */
  taxRate?: number;
};

/** A generated invoice for one client over one date range. */
export type Invoice = {
  id: string;
  workspaceId: string;
  /** Audit only — never used for scoping. */
  createdBy: string;
  /** Human-facing number, unique per workspace, e.g. "2026-014". */
  number: string;
  clientId: string;
  /** Snapshot of the client's name at issue time. */
  clientName: string;
  status: InvoiceStatus;
  /** ISO date. */
  issueDate: string;
  /** ISO date. */
  dueDate: string;
  /** ISO date or datetime — start of the billed range, inclusive. */
  from: string;
  /** ISO date or datetime — end of the billed range. */
  to: string;
  /** Whether lines are one-per-project or one-per-task. */
  groupBy: "project" | "task";
  lineItems: InvoiceLineItem[];
  subtotal: number;
  /** Percent, e.g. 19 for 19% VAT. Null = no tax line. */
  taxRate: number | null;
  taxAmount: number;
  total: number;
  currency: string;
  /**
   * Every entry billed on this invoice. Source of truth for the
   * double-billing guard — `TimeEntry.invoiceId` is the denormalized index
   * over it.
   */
  entryIds: string[];
  notes: string | null;
  /**
   * The language the document is rendered in, snapshotted at creation like
   * every figure on it. Absent on invoices issued before localisation, which
   * were English and must stay English on every re-render.
   */
  locale?: Locale;
  /**
   * The business profile as it stood when the invoice was created. `null` on
   * an invoice created before issuer snapshots existed, or while the profile
   * was empty. Never re-read from the live profile.
   */
  issuer?: InvoiceIssuer | null;
  /**
   * The client's billing details as they stood at creation. `null` on older
   * invoices; `clientName` is then the whole of "Billed to".
   */
  recipient?: InvoiceRecipient | null;
  /** EN 16931 VAT breakdown, stored at creation. Absent when categories were not resolved. */
  taxBreakdown?: TaxBreakdownRow[];
  /** BT-20: the due sentence in the invoice's language, frozen at create or fill. */
  paymentTerms?: string | null;
  /** Audit of attachEinvoiceData calls. Absent when none happened. */
  einvoiceFills?: EinvoiceFill[];
  createdAt: string;
  updatedAt: string;
};

/** Every business profile value, blanks collapsed — what `normalizeBusinessProfile` returns. */
export type BusinessProfileValues = Omit<BusinessProfile, "workspaceId" | "updatedAt">;

/**
 * Snapshot of {@link BusinessProfile} copied onto one invoice. The defaults
 * steer create and are not facts about the issuer, so they are left out.
 */
export type InvoiceIssuer = Omit<
  BusinessProfileValues,
  "defaultTaxCategory" | "defaultTaxRate" | "smallBusinessNote"
>;

/** Snapshot of the client's name and {@link ClientBilling} on one invoice. */
export type InvoiceRecipient = Omit<ClientBilling, "preferredFormat" | "defaultTaxCategory"> & {
  /** The client's display name at issue time — same value as `clientName`. */
  name: string;
};
