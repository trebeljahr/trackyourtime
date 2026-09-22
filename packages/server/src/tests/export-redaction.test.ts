// The export is a bulk door: one call hands over every row a report would
// serve a page at a time. So these tests do NOT check a list of known money
// fields — they WALK the produced document and fail on any money-named value
// that survived. A field added to the export later without a redaction rule
// fails here rather than shipping as a silent disclosure.
//
// The walk only catches a new field if the fixture HOLDS one, and that is the
// half a hand-written literal gets wrong: every section this format has grown
// so far arrived optional (`settings?`, `favorites?`, `invoices?`), so an
// optional money field typechecks against a fixture that never mentions it and
// the walker is never pointed at it. The fixture is therefore typed
// `Required<...>` at every level — see {@link ExhaustiveExport}. A new field,
// optional or not, fails to compile until it is filled in here, and then fails
// the walk until it is redacted there.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  BusinessProfileValues,
  Visibility,
  WorkspaceExport,
  WorkspaceExportClient,
  WorkspaceExportEntry,
  WorkspaceExportFavorite,
  WorkspaceExportInvoice,
  WorkspaceExportInvoiceLine,
  WorkspaceExportProject,
  WorkspaceExportSettings,
  WorkspaceExportTag,
  WorkspaceExportTask,
} from "@starter/shared";
import {
  exportKeepsMoney,
  redactExportMoney,
} from "../services/export-redaction.js";

/**
 * Anything that could carry an amount. Deliberately wider than the fields
 * that exist today: the next money field somebody adds to this format —
 * `budgetAmount` was one, an invoice's `total` another — must be born
 * redacted, and this is what makes forgetting a rule fail loudly.
 *
 * Quantities are deliberately absent (`hours`, `seconds`, `durationSec`) and
 * so is `billable`: those are time and policy, they survive a redaction on
 * purpose, and a regex that matched them would fail every run.
 */
const MONEY_KEY =
  /(rate|amount|price|cost|money|earn|revenue|billed|billing|budget|total|salary|fee|discount|net|gross|payout|charge|margin|retainer|wage|sum|value|credit|balance|invoiced|owed|paid)/i;

type Leaf = { path: string; key: string; value: unknown };

const walk = (value: unknown, path: string, out: Leaf[]): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  const key = path.split(".").at(-1)?.replace(/\[\d+\]$/, "") ?? path;
  out.push({ path, key, value });
};

const leavesOf = (document: WorkspaceExport): Leaf[] => {
  const leaves: Leaf[] = [];
  walk(document, "", leaves);
  return leaves;
};

/** Every leaf in the document whose key reads like money. */
const moneyLeaves = (document: WorkspaceExport): Leaf[] =>
  leavesOf(document).filter((leaf) => MONEY_KEY.test(leaf.key));

const visibility = (
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Visibility => ({ userId: "user-1", canViewOthersTime, canViewOthersMoney });

/**
 * The export type with every optional key made mandatory, at every level.
 *
 * `moneyRedacted` is the one exception, and only because it is the STAMP
 * rather than a field of the workspace: an unredacted document must not carry
 * it, so a fixture forced to set it could not represent one.
 */
type ExhaustiveExport = Required<
  Omit<WorkspaceExport, "moneyRedacted" | "newerVersion">
> & {
  businessProfile: BusinessProfileValues;
  /** Typed `undefined` rather than dropped: readable, and impossible to set. */
  moneyRedacted?: undefined;
  /** Set by the reader only; an export never writes it. */
  newerVersion?: undefined;
  settings: Required<WorkspaceExportSettings>;
  clients: Required<WorkspaceExportClient>[];
  projects: Required<WorkspaceExportProject>[];
  tasks: Required<WorkspaceExportTask>[];
  tags: Required<WorkspaceExportTag>[];
  entries: Required<WorkspaceExportEntry>[];
  favorites: Required<WorkspaceExportFavorite>[];
  invoices: (Required<WorkspaceExportInvoice> & {
    lineItems: Required<WorkspaceExportInvoiceLine>[];
  })[];
};

const fixture = (): ExhaustiveExport => ({
  version: 2,
  exportedAt: "2026-09-07T10:00:00.000Z",
  workspaceId: "workspace-1",
  currency: "EUR",
  settings: { defaultHourlyRate: 95, weekStartsOn: 1 },
  businessProfile: {
    legalName: "Alice Consulting",
    addressLines: ["Hauptstr. 1"],
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
    taxId: "DE123456789",
    email: "billing@example.com",
    phone: null,
    website: null,
    paymentDetails: "IBAN DE00 0000 0000 0000",
    paymentTermsDays: 14,
    invoiceFooter: null,
    vatId: "DE123456789",
    taxNumber: null,
    registrationNumber: null,
    sellerIdentifier: null,
    contactName: "Alice Example",
    electronicAddress: "billing@example.com",
    electronicAddressScheme: "EM",
    iban: "DE02120300000000202051",
    bic: null,
    bankName: null,
    accountHolder: null,
    smallBusiness: false,
    smallBusinessNote: null,
    defaultTaxCategory: "S",
    defaultTaxRate: 19,
  },
  clients: [
    {
      name: "Internal",
      color: "#111111",
      archived: false,
      billing: {
        legalName: "Internal GmbH",
        addressLines: ["Weg 2"],
        postalCode: "20095",
        city: "Hamburg",
        country: "DE",
        taxId: null,
        email: null,
        reference: "PO-7",
        vatId: "DE987654321",
        electronicAddress: null,
        electronicAddressScheme: null,
        preferredFormat: "zugferd",
        defaultTaxCategory: "S",
      },
    },
  ],
  projects: [
    {
      name: "trackyourtime",
      color: "#222222",
      clientName: "Internal",
      billableDefault: true,
      hourlyRate: 120,
      estimatedHours: 40,
      budgetAmount: 5_000,
      budgetCurrency: "EUR",
      idleBehavior: null,
      archived: false,
    },
    {
      name: "Unpriced",
      color: "#333333",
      clientName: null,
      billableDefault: false,
      hourlyRate: null,
      estimatedHours: null,
      budgetAmount: null,
      budgetCurrency: null,
      idleBehavior: null,
      archived: true,
    },
  ],
  tasks: [
    { name: "Imports", color: "#333333", archived: false },
  ],
  tags: [{ name: "deep work", color: "#444444", archived: false }],
  entries: [
    {
      description: "Wrote the exporter",
      clientName: "Internal",
      projectName: "trackyourtime",
      taskName: "Imports",
      tagNames: ["deep work"],
      billable: true,
      start: "2026-08-21T09:00:00.000Z",
      end: "2026-08-21T10:30:00.000Z",
      durationSec: 5400,
      // The project's rate, snapshotted onto the row — which is exactly why
      // it may not travel with a member who cannot see the project's rate.
      hourlyRate: 120,
      currency: "EUR",
      timeZone: "Europe/Berlin",
    },
    {
      description: "Read the importer",
      clientName: null,
      projectName: null,
      taskName: null,
      tagNames: [],
      billable: false,
      start: "2026-08-22T09:00:00.000Z",
      end: "2026-08-22T09:30:00.000Z",
      durationSec: 1800,
      hourlyRate: null,
      currency: "EUR",
      timeZone: null,
    },
    {
      description: "Meeting on an unpriced project",
      clientName: null,
      projectName: "Unpriced",
      taskName: null,
      tagNames: [],
      billable: true,
      start: "2026-08-23T09:00:00.000Z",
      end: "2026-08-23T10:00:00.000Z",
      durationSec: 3600,
      // No project rate, so this one carries the WORKSPACE default — the
      // second figure a redacted `settings.defaultHourlyRate` hides.
      hourlyRate: 95,
      currency: "EUR",
      timeZone: null,
    },
  ],
  favorites: [
    {
      description: "Stand-up",
      clientName: "Internal",
      projectName: "trackyourtime",
      taskName: null,
      billable: false,
      order: 0,
    },
  ],
  invoices: [
    {
      number: "2026-014",
      clientName: "Internal",
      status: "sent",
      issueDate: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-09-15T00:00:00.000Z",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
      groupBy: "project",
      lineItems: [
        {
          label: "trackyourtime",
          projectName: "trackyourtime",
          taskName: null,
          seconds: 5400,
          hours: 1.5,
          hourlyRate: 120,
          currency: "EUR",
          amount: 180,
          taxCategory: "S",
          taxRate: 19,
        },
      ],
      subtotal: 180,
      taxRate: 19,
      taxAmount: 34.2,
      total: 214.2,
      currency: "EUR",
      notes: null,
      issuer: {
        legalName: "Alice Consulting",
        addressLines: [],
        postalCode: null,
        city: "Berlin",
        country: null,
        taxId: null,
        email: null,
        phone: null,
        website: null,
        paymentDetails: "IBAN DE00 0000 0000 0000",
        paymentTermsDays: 14,
        invoiceFooter: null,
        vatId: "DE123456789",
        taxNumber: null,
        registrationNumber: null,
        sellerIdentifier: null,
        contactName: null,
        electronicAddress: null,
        electronicAddressScheme: null,
        iban: "DE02120300000000202051",
        bic: null,
        bankName: null,
        accountHolder: null,
        smallBusiness: false,
      },
      recipient: {
        name: "Internal",
        legalName: null,
        addressLines: [],
        postalCode: null,
        city: "Hamburg",
        country: null,
        taxId: null,
        email: null,
        reference: null,
        vatId: null,
        electronicAddress: null,
        electronicAddressScheme: null,
      },
      taxBreakdown: [
        {
          category: "S",
          rate: 19,
          basisAmount: 180,
          taxAmount: 34.2,
          exemptionReason: null,
          exemptionReasonCode: null,
        },
      ],
      paymentTerms: "Payable within 14 days, by 2026-09-15.",
      createdAt: "2026-09-01T09:00:00.000Z",
    },
  ],
});

/**
 * Sections a redaction removes whole rather than blanking. The business
 * profile and the parties frozen on each invoice carry payment details, and
 * reading them takes the money flag, so a redacted file does not state them
 * at all — and an import reads their absence as "not said".
 */
const IDENTITY_PATH =
  /^(businessProfile|invoices\[\d+\]\.(issuer|recipient|taxBreakdown))(\.|\[|$)/;

/** Both configurations that are refused money, run through every rule below. */
const REDACTED_VIEWERS: readonly Visibility[] = [
  // Sees every member's rows, none of their money.
  visibility(true, false),
  // The most locked-down member: their own rows, and no money at all.
  visibility(false, false),
];

test("the walker actually finds the money fields it is meant to guard", () => {
  // Guards every test below from passing vacuously: if the walk stopped
  // finding rates, "no rate survived" would be true of an unredacted document.
  const paths = moneyLeaves(fixture()).map((leaf) => leaf.path);
  assert.ok(paths.includes("projects[0].hourlyRate"));
  assert.ok(paths.includes("entries[0].hourlyRate"));
  assert.ok(paths.includes("projects[0].budgetAmount"));
  assert.ok(paths.includes("settings.defaultHourlyRate"));
  assert.ok(paths.includes("invoices[0].total"));
  assert.ok(paths.includes("invoices[0].lineItems[0].amount"));
  assert.ok(paths.includes("invoices[0].lineItems[0].taxRate"));
  assert.ok(paths.includes("invoices[0].taxBreakdown[0].taxAmount"));
});

test("a redacted invoice loses its VAT breakdown and line rates, and keeps categories and terms", () => {
  for (const viewer of REDACTED_VIEWERS) {
    const invoice = redactExportMoney(fixture(), viewer).invoices?.[0];
    assert.ok(invoice);
    // Every row of a breakdown is a basis and a tax amount: it goes whole.
    assert.equal("taxBreakdown" in invoice, false);
    assert.strictEqual(invoice.lineItems[0]?.taxRate, null);
    // A category and the due sentence state no figure.
    assert.equal(invoice.lineItems[0]?.taxCategory, "S");
    assert.equal(invoice.paymentTerms, "Payable within 14 days, by 2026-09-15.");
  }
  const kept = redactExportMoney(fixture(), visibility(true, true)).invoices?.[0];
  assert.equal(kept?.taxBreakdown?.[0]?.taxAmount, 34.2);
  assert.equal(kept?.lineItems[0]?.taxRate, 19);
});

test("a member who may not see others' money gets a document with no amount anywhere", () => {
  for (const viewer of REDACTED_VIEWERS) {
    const redacted = redactExportMoney(fixture(), viewer);

    for (const leaf of moneyLeaves(redacted)) {
      // `moneyRedacted: true` is the stamp, not an amount — every other
      // money-named leaf must be empty, and empty means null.
      if (typeof leaf.value === "boolean") continue;
      assert.strictEqual(
        leaf.value,
        null,
        `${leaf.path} left an amount in the export for ${JSON.stringify(viewer)}: ${String(leaf.value)}`,
      );
      // Zero is the trap, not the fix: a rate of 0 re-imports as a real rate
      // and prices the restored history at nothing, forever, without an error.
      assert.notStrictEqual(leaf.value, 0);
    }

    assert.equal(redacted.moneyRedacted, true);
  }
});

test("an entry's own rate is the rate card, so it goes with the rate card", () => {
  // The disclosure this rule exists for: `resolveHourlyRate` snapshots the
  // project's rate (or the workspace default) onto every entry, so keeping
  // entry rates for a member scoped to their own rows would hand back both
  // redacted figures — 120 keyed by "trackyourtime", 95 from the default — and a
  // billable second booked against each project enumerates the whole card.
  const redacted = redactExportMoney(fixture(), visibility(false, false));

  assert.equal(exportKeepsMoney(visibility(false, false)), false);
  assert.strictEqual(redacted.entries[0]?.hourlyRate, null);
  assert.strictEqual(redacted.entries[2]?.hourlyRate, null);
  assert.strictEqual(redacted.projects[0]?.hourlyRate, null);
  assert.strictEqual(redacted.settings?.defaultHourlyRate, null);
  assert.strictEqual(redacted.invoices?.[0]?.total, null);
  assert.equal(redacted.moneyRedacted, true);
});

test("the stamp means what it says: it is set exactly when an amount was taken", () => {
  // `moneyRedacted` is the flag the panel renders and the import preview
  // repeats. A document that carries the stamp and an amount, or an amount
  // and no stamp, makes both of those statements false.
  for (const viewer of [...REDACTED_VIEWERS, visibility(true, true)]) {
    const redacted = redactExportMoney(fixture(), viewer);
    const survivors = moneyLeaves(redacted).filter(
      (leaf) => typeof leaf.value === "number",
    );
    assert.equal(
      redacted.moneyRedacted === true,
      survivors.length === 0,
      `stamp disagrees with the file for ${JSON.stringify(viewer)}`,
    );
  }
});

test("redaction blanks fields and never drops them", () => {
  // A missing key and a null one read differently on the way back in, and a
  // redaction that silently changed the SHAPE of the document would break the
  // round trip rather than just the amounts.
  const before = leavesOf(fixture())
    .map((leaf) => leaf.path)
    .filter((path) => !IDENTITY_PATH.test(path));
  const after = leavesOf(
    redactExportMoney(fixture(), visibility(true, false)),
  ).map((leaf) => leaf.path);
  assert.deepEqual(after.filter((path) => path !== "moneyRedacted"), before);
});

test("redaction takes the money and nothing else", () => {
  const original = fixture();
  const redacted = redactExportMoney(original, visibility(true, false));

  assert.equal(redacted.entries.length, 3);
  assert.equal(redacted.entries[0]?.durationSec, 5400);
  assert.equal(redacted.entries[0]?.billable, true);
  assert.deepEqual(redacted.entries[0]?.tagNames, ["deep work"]);
  // Currency is the workspace's unit, not anybody's earnings, and the round
  // trip's Currency column depends on it.
  assert.equal(redacted.entries[0]?.currency, "EUR");
  assert.equal(redacted.currency, "EUR");
  // Hours are a time target; the time question is `canViewOthersTime`.
  assert.equal(redacted.projects[0]?.estimatedHours, 40);
  assert.equal(redacted.projects[0]?.name, "trackyourtime");
  assert.deepEqual(redacted.clients, original.clients);
  assert.deepEqual(redacted.tasks, original.tasks);
  assert.deepEqual(redacted.tags, original.tags);
  // Pins carry no amounts at all — `billable` is a flag, not a figure — so
  // the whole section survives a money redaction untouched.
  assert.deepEqual(redacted.favorites, original.favorites);
  // Calendar policy is not money, and an invoice without its quantities could
  // not be read as a record of anything.
  assert.equal(redacted.settings?.weekStartsOn, 1);
  assert.equal(redacted.invoices?.[0]?.number, "2026-014");
  assert.equal(redacted.invoices?.[0]?.status, "sent");
  assert.equal(redacted.invoices?.[0]?.lineItems[0]?.hours, 1.5);
  assert.equal(redacted.invoices?.[0]?.lineItems[0]?.seconds, 5400);
  assert.equal(redacted.invoices?.[0]?.currency, "EUR");
});

test("a redacted export states no business profile and no invoice parties", () => {
  for (const viewer of REDACTED_VIEWERS) {
    const redacted = redactExportMoney(fixture(), viewer);
    assert.equal("businessProfile" in redacted, false);
    assert.equal("issuer" in (redacted.invoices?.[0] ?? {}), false);
    assert.equal("recipient" in (redacted.invoices?.[0] ?? {}), false);
    // A client's billing address is catalog, not money: it survives.
    assert.equal(redacted.clients[0]?.billing?.reference, "PO-7");
  }
  const kept = redactExportMoney(fixture(), visibility(true, true));
  assert.equal(kept.businessProfile?.taxId, "DE123456789");
  assert.equal(kept.invoices?.[0]?.issuer?.city, "Berlin");
});

test("a redacted budget loses its currency with its amount", () => {
  const redacted = redactExportMoney(fixture(), visibility(true, false));
  const project = redacted.projects[0];
  assert.ok(project);
  assert.strictEqual(project.budgetAmount, null);
  // The one currency that DOES go: half a budget describes nothing, and a
  // lone "EUR" on a project would only look like a fact that went missing.
  assert.strictEqual(project.budgetCurrency, null);
  // The entry and workspace currencies are the workspace's unit and stay.
  assert.equal(redacted.currency, "EUR");
  assert.equal(redacted.entries[0]?.currency, "EUR");
});

test("a redacted rate is null, which the CSV writes as an empty cell", () => {
  const redacted = redactExportMoney(fixture(), visibility(true, false));
  const entry = redacted.entries[0];
  assert.ok(entry);
  // The exact expression the CSV door uses, on the exact value it is fed —
  // the CSV is built from the redacted document, so it cannot disagree.
  assert.strictEqual(entry.hourlyRate ?? "", "");
});

test("redaction does not mutate the document it was handed", () => {
  const original = fixture();
  redactExportMoney(original, visibility(true, false));
  assert.equal(original.entries[0]?.hourlyRate, 120);
  assert.equal(original.projects[0]?.hourlyRate, 120);
  assert.equal(original.settings?.defaultHourlyRate, 95);
  assert.equal(original.invoices?.[0]?.lineItems[0]?.amount, 180);
  assert.equal(original.moneyRedacted, undefined);
});

test("a member who may see others' money gets the document untouched", () => {
  const original = fixture();
  const kept = redactExportMoney(original, visibility(true, true));

  assert.deepEqual(kept, original);
  assert.equal(kept.moneyRedacted, undefined);
  assert.equal(kept.entries[0]?.hourlyRate, 120);
  assert.strictEqual(kept.projects[0]?.hourlyRate, 120);
  assert.equal(exportKeepsMoney(visibility(true, true)), true);
});
