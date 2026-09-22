// Money on the way out of the workspace.
//
// An export is a BULK door onto the same rows a report serves a page at a
// time. WHICH entries leave is the author scope (`authorScopeFilter`, the same
// one `buildMatchConditions` in reports.ts and `listEntries` use); whether
// invoices leave at all is `canUseInvoices`, decided in the export builder.
// This module answers the remaining question: which money survives on what
// does leave.
//
// The page-at-a-time siblings answer it too — `entries.list`/`entries.get`
// project colleagues' rows through `projectDetailedEntry`, reports withhold
// every amount when `reportMoneyVisible` is false, `projects.list` nulls
// budget progress and `invoices.*` refuse. The export rule is STRICTER than
// theirs on purpose (see `exportKeepsMoney`): a file re-imports, and the rate
// on one's own row is the project's rate card. `settings.get` still hands the
// workspace default rate to every member.
//
// Pure on purpose — no database, no request. The export builder assembles the
// document, this decides what of it the caller may keep, and the CSV door is
// built from the already-redacted document rather than redacting a second
// time. Two implementations of one rule is how the two doors come to disagree.
import type {
  Visibility,
  WorkspaceExport,
  WorkspaceExportEntry,
  WorkspaceExportInvoice,
  WorkspaceExportProject,
  WorkspaceExportSettings,
} from "@starter/shared";

/**
 * Whether the caller keeps ANY of the money in the export.
 *
 * ONE predicate, deliberately, and with no author-scope escape hatch. The
 * tempting second rule — "scoped to their own rows, so their own rates are
 * their own money" — is false about this format: an entry's `hourlyRate` is
 * not a figure the author chose, it is the PROJECT rate card copied onto the
 * row by `resolveHourlyRate`, falling back to `settings.defaultHourlyRate`.
 * A document that blanks `projects[].hourlyRate` and then hands the same
 * number back on `entries[].hourlyRate` beside its `projectName` has
 * published exactly what it just redacted, and one billable second booked
 * against each project in `projects.list` enumerates the rest of the card.
 *
 * The other half — project budgets, the workspace default rate, every figure
 * on an invoice — was never member-scoped and never can be: a project's rate
 * states what everybody billing it earns, and an invoice line merges whoever's
 * hours were billed into one amount.
 */
export function exportKeepsMoney(visibility: Visibility): boolean {
  return visibility.canViewOthersMoney;
}

/**
 * Strip every money-bearing field the caller may not see.
 *
 * Redacts to `null`, NEVER to `0`. A rate is a stored value, not a computed
 * amount: `0` is a real number to both parsers (`parseAmount("0")`, and the
 * `typeof === "number"` check on JSON entries), and on commit a row's own `0`
 * WINS over the destination rate card because `??` falls through on null and
 * not on zero — so a `0`-redacted export re-imports as history permanently
 * priced at nothing, with no error anywhere along the way. `null` is what an
 * absent rate already parses to, so a redacted file re-prices from the
 * destination workspace's own rate card, exactly like any rate-less file.
 *
 * `currency` is deliberately NOT redacted, here or in the CSV. A currency
 * code is the workspace's unit rather than anybody's earnings, reports hand
 * it to every member already, and blanking it would break the round trip's
 * Currency column for no confidentiality gain. `budgetCurrency` is the one
 * exception, and only because it is half of a pair: with its amount gone it
 * describes nothing, so the two go together.
 *
 * Every money field this format grows must be listed HERE, not merely typed
 * `number | null`. `settings.defaultHourlyRate` and the invoice figures are
 * the widest of them — one states what unpriced work is worth across the
 * whole workspace, the other what customers were actually charged.
 */
export function redactExportMoney(
  document: WorkspaceExport,
  visibility: Visibility,
): WorkspaceExport {
  if (exportKeepsMoney(visibility)) return document;

  const entries: WorkspaceExportEntry[] = document.entries.map((entry) => ({
    ...entry,
    hourlyRate: null,
  }));

  const projects: WorkspaceExportProject[] = document.projects.map(
    (project) => ({
      ...project,
      hourlyRate: null,
      budgetAmount: null,
      budgetCurrency: null,
    }),
  );

  const settings: WorkspaceExportSettings | undefined = document.settings
    ? { ...document.settings, defaultHourlyRate: null }
    : document.settings;

  // Invoices keep their quantities — hours are a time question, and an
  // invoice with no seconds on it could not be read as a record at all — and
  // lose every amount, including `taxRate`, which is a percent of exactly the
  // figures that just went. The VAT breakdown goes whole (every row is a basis
  // and a tax amount) and a line's rate goes with the amounts; its category
  // and the payment terms sentence state no figure and stay.
  const invoices: WorkspaceExportInvoice[] | undefined = document.invoices
    ? document.invoices.map(({ taxBreakdown: _breakdown, ...invoice }) => {
        void _breakdown;
        return {
          ...invoice,
          subtotal: null,
          taxRate: null,
          taxAmount: null,
          total: null,
          lineItems: invoice.lineItems.map((line) => ({
            ...line,
            hourlyRate: null,
            amount: null,
            // A manual line's price per unit is its rate: it goes with them.
            ...(line.unitPrice !== undefined ? { unitPrice: null } : {}),
            ...(line.taxRate !== undefined ? { taxRate: null } : {}),
          })),
        };
      })
    : document.invoices;

  // The business profile carries payment details, and reading it takes what
  // reading money takes (`settings.businessProfile`). The snapshots on each
  // invoice go for the same reason — the issuer's copy carries them too.
  const { businessProfile: _profile, ...rest } = document;
  void _profile;
  const strippedInvoices = invoices?.map(
    ({ issuer: _issuer, recipient: _recipient, ...invoice }) => {
      void _issuer;
      void _recipient;
      return invoice;
    },
  );

  // Stamped so a restore cannot read "every rate is null" as "this workspace
  // never billed anything". A redacted export is a real backup of times and
  // catalog and an incomplete one of money, and the file says which it is
  // rather than leaving that to be discovered. The importer reads it back and
  // the preview states it before anything is written — see `ImportSections`.
  return {
    ...rest,
    moneyRedacted: true,
    settings,
    projects,
    entries,
    invoices: strippedInvoices,
  };
}
