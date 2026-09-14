// Projecting a payload down to what one caller may see.
//
// `authorScopeFilter` on the server keeps invisible rows out of a QUERY. This
// module is the other half: the surfaces that hand a row to somebody without
// re-running that query — the REST responses, a webhook delivery — need a
// value-level answer to the same question, and it must be the same answer.
//
// Lives in @starter/shared rather than the server so it can be unit-tested
// without a database, and so the clients can reason about a stripped payload
// instead of rendering `hourlyRate: null` as "€0/h".
import type { BudgetProgress } from "./budgets.js";
import type {
  CatalogRemoveResult,
  TimeEntry,
  Visibility,
  WorkspaceRole,
} from "./types.js";
import type { DetailedEntry } from "./reports.js";

/** The two flags, without the `userId` that only a live request has. */
export type VisibilityGrant = {
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
};

/** May this caller see that this entry exists at all? */
export function canSeeEntry(
  visibility: Visibility,
  authorId: string,
): boolean {
  return authorId === visibility.userId || visibility.canViewOthersTime;
}

/** May this caller see what this entry is worth? */
export function canSeeMoneyFor(
  visibility: Visibility,
  authorId: string,
): boolean {
  return authorId === visibility.userId || visibility.canViewOthersMoney;
}

/**
 * The entry as this caller may see it, or `null` when they may not see it.
 *
 * `currency` survives a money strip on purpose: it is workspace configuration
 * ("this workspace bills in EUR"), not an amount, and removing it would leave
 * the client with no way to format the caller's OWN entries in the same list.
 */
export function projectEntryForVisibility(
  entry: TimeEntry,
  visibility: Visibility,
): TimeEntry | null {
  if (!canSeeEntry(visibility, entry.authorId)) return null;
  if (canSeeMoneyFor(visibility, entry.authorId)) return entry;
  return { ...entry, hourlyRate: null };
}

/**
 * The same, for a report row.
 *
 * `amount` is withheld as `null` alongside the rate, never copied through —
 * that would hand back the exact number the rate strip exists to withhold —
 * and never recomputed to `0`, which is what genuinely unbillable time earns
 * and what a spreadsheet summing the column would silently believe.
 */
export function projectDetailedEntry(
  entry: DetailedEntry,
  visibility: Visibility,
): DetailedEntry | null {
  if (!canSeeEntry(visibility, entry.authorId)) return null;
  if (canSeeMoneyFor(visibility, entry.authorId)) return entry;
  return { ...entry, hourlyRate: null, amount: null };
}

/**
 * Whether a report scoped to this caller may carry money at all.
 *
 * False in exactly one of the four combinations: the report spans colleagues'
 * time (`canViewOthersTime`) while their money is closed. A caller restricted
 * to their own time sees only their own rows, so every amount is their own;
 * a caller with both flags may see all of it. The same predicate REST's
 * `requireMoneyVisibility` refuses on — tRPC projects instead of refusing,
 * because the web app has time to show even when it has no money to show.
 */
export function reportMoneyVisible(visibility: Visibility): boolean {
  return !(visibility.canViewOthersTime && !visibility.canViewOthersMoney);
}

/**
 * May this member use invoicing in this workspace — list, read, create,
 * change or delete invoices?
 *
 * An invoice is money end to end AND it merges whoever's billable hours fall
 * in its range into one line, so the only caller it is honest to hand one to
 * is somebody who may already see every colleague's time and every
 * colleague's money. Role is required on top of both flags because issuing a
 * document to a customer is a workspace decision, not a visibility one: a
 * plain member with both flags open may read the numbers in a report, but
 * does not bill the client.
 *
 * The owner of a personal workspace has both flags forced on, so solo use is
 * unaffected.
 */
export function canUseInvoices(
  role: WorkspaceRole,
  visibility: Visibility,
): boolean {
  return (
    (role === "owner" || role === "admin") &&
    visibility.canViewOthersTime &&
    visibility.canViewOthersMoney
  );
}

/**
 * Intersect a live visibility with the ceiling a credential was minted under.
 *
 * Neither half alone is safe. A pure snapshot keeps returning rates after its
 * owner is demoted — the grant outlives the permission, silently. A pure live
 * read is worse in the other direction: a token minted while its owner could
 * see only their own time starts emitting the whole workspace's money the day
 * somebody ticks `canViewOthersMoney`, with no one re-authorising the token.
 *
 * ANDing the two makes revocation take effect on the next request and makes a
 * later grant require a NEW token. `userId` always comes from the live side —
 * it identifies the person, and a person does not change.
 */
export function narrowVisibility(
  live: Visibility,
  ceiling: VisibilityGrant,
): Visibility {
  return {
    userId: live.userId,
    canViewOthersTime: live.canViewOthersTime && ceiling.canViewOthersTime,
    canViewOthersMoney: live.canViewOthersMoney && ceiling.canViewOthersMoney,
  };
}

/**
 * The project fields whose visibility depends on who is asking.
 *
 * Structural rather than the concrete `Project`, so the ONE rule below covers
 * both shapes a REST read hands back: the aggregated row that carries
 * `progress`, and the bare row a create/update/archive returns that does not.
 */
export type ProjectMoneyView = {
  /**
   * Every project shape carries one, and naming it here is load-bearing: a
   * type whose only member is optional is a "weak type", which TypeScript
   * refuses to match against a row that happens not to have that member — so
   * a `progress`-less create response would not compile against this rule at
   * all, and the tempting fix is to stop projecting the write routes.
   */
  id: string;
  progress?: BudgetProgress | null;
};

/**
 * The project as this caller may see it.
 *
 * THE MONEY RULE, decided once here so the next reviewer does not re-derive
 * it from four call sites:
 *
 * - `progress` is DERIVED, and it derives from EVERY member's entries:
 *   `spentAmount` is aggregate colleague earnings, `trackedSec` aggregate
 *   colleague hours. It is the one project field that discloses other
 *   people's work, so it is the one that is withheld.
 * - `hourlyRate`, `budgetAmount` and `budgetCurrency` are workspace
 *   CONFIGURATION, not a colleague's money. The rate is the one the caller's
 *   OWN entries are already stamped with — it is on every row `/entries`
 *   hands them — and the budget is the target the job was sold at. Neither is
 *   derived from anybody else's work, so both stay.
 *
 * It takes BOTH flags because it mixes both dimensions. A caller with money
 * but not time still differences colleague hours out of `trackedSec`; a
 * caller with time but not money reads colleague earnings straight off
 * `spentAmount`. Either flag alone is a hole, so the rule is the conjunction.
 *
 * THE INVARIANT THE RATE DEPENDS ON — and the sentence that used to be wrong
 * here. This block once said the rate is safe to ship "beside the entries it
 * prices", full stop, and that claim is what made a live leak look reviewed:
 * `spentAmount` is `hourlyRate x totalSec / 3600`, so shipping the rate next
 * to a WHOLE-WORKSPACE `totalSec` withheld nothing at all — one multiplication
 * rebuilt the number, and subtracting the caller's own total gave a
 * colleague's earnings. A withheld aggregate is only withheld if its FACTORS
 * are too. The rate stays because `rollupVisibility` below makes the total
 * beside it count the caller's OWN entries whenever the money is withheld; it
 * would have to go the day that stops being true.
 *
 * Withheld as `null`, never as zero: null is the shape's existing "no target
 * set" signal, which every client already renders as "no budget". A zeroed
 * progress renders as "0% of 4,000 spent" — a claim about money, and a false
 * one.
 */
export function projectProjectForVisibility<T extends ProjectMoneyView>(
  project: T,
  visibility: Visibility,
): T {
  if (visibility.canViewOthersTime && visibility.canViewOthersMoney) {
    return project;
  }
  // Only rewrite a shape that HAS the field. Adding `progress: null` to a
  // create response that never carried one would change the wire shape of a
  // route that discloses nothing, and teach clients to expect a key that is
  // absent everywhere else.
  if (!("progress" in project)) return project;
  return { ...project, progress: null };
}

/**
 * The visibility a catalog roll-up (`entryCount`, `totalSec`) must be computed
 * under: the CONJUNCTION of the two flags, never the time flag alone.
 *
 * A roll-up is a FACTOR of the aggregate `projectProjectForVisibility`
 * withholds, so scoping it on `canViewOthersTime` leaves exactly the one
 * visibility where the two rules disagree — `canViewOthersTime: true,
 * canViewOthersMoney: false` — shipping both halves of the number it refuses:
 * `progress` came back null beside an unscoped `totalSec` and the project's
 * `hourlyRate`, and `hourlyRate x totalSec / 3600` is `spentAmount` exactly.
 * Per colleague, too, by subtracting the caller's own total. That visibility
 * is already judged too dangerous for money-bearing shapes elsewhere —
 * `requireMoneyVisibility` refuses `GET /entries` and every report for it —
 * and the catalog roll-up was the one surface still serving it.
 *
 * So the total is author-scoped whenever the money it prices is withheld. The
 * same narrowing is applied to the project, task AND tag roll-ups: a rule with
 * an exception is a rule nobody can check, and the tag roll-up is the widest
 * of the three (it totals the whole workspace's work per label).
 *
 * Identity in every other case, so a caller who may see everything runs
 * exactly the pipeline that was there before, and a caller who may not see
 * others' time is already restricted by the flag itself.
 */
export function rollupVisibility(visibility: Visibility): Visibility {
  if (visibility.canViewOthersTime && !visibility.canViewOthersMoney) {
    return { ...visibility, canViewOthersTime: false };
  }
  return visibility;
}

/**
 * The caller's own share of what a cascading delete detached, counted by the
 * service before it cascaded. `null` means the caller may be told the
 * workspace's numbers as they are.
 */
export type OwnCollateralCounts = Pick<
  CatalogRemoveResult,
  "entriesDetached" | "favoritesDetached"
>;

/**
 * What a catalog delete may report back.
 *
 * `cascadeDelete*` counts what it touched across the WHOLE workspace, which is
 * right for the sync event it drives and a disclosure in the response: a
 * member with `canViewOthersTime: false` — who now sees only their own
 * `entryCount`/`totalSec` on a catalog read — got the colleague entry count
 * straight back off `entriesDetached` by deleting the project, and the
 * colleagues' pin count off `favoritesDetached`. The same number the roll-up
 * withholds, handed over by the other verb.
 *
 * Replaced with the caller's own counts rather than zeroed: zero is not the
 * safe answer here but a false one, because every client renders an all-zero
 * result as "Nothing else referenced it" — a claim about the caller's OWN
 * entries, and wrong whenever they had any.
 *
 * `tasksDeleted` and `projectsDetached` survive untouched on purpose. They
 * count CATALOG rows, which every member may already list in full; withholding
 * them would hide the actual consequence of the delete while disclosing
 * nothing.
 */
export function projectRemoveResult(
  result: CatalogRemoveResult,
  own: OwnCollateralCounts | null,
): CatalogRemoveResult {
  if (own === null) return result;
  return { ...result, ...own };
}
