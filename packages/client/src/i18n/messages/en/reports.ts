/**
 * English `reports` messages — the SOURCE catalog for reports (Totals and Entries), charts, budgets and invoices.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/reports.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const reports = {
  invoiceIdentity: {
    profileMissing: "Your business profile has no address, so this invoice will not say who issued it.",
    profileLink: "Complete the business profile",
    clientMissing: "{client} has no billing address, so this invoice will show only the client name.",
    clientLink: "Add billing details",
    dueFromTerms: "Due date set from your payment terms of {days, plural, one {# day} other {# days}}.",
  },

  /** The one Reports screen: its header and the Totals / Entries switch. */
  screen: {
    title: "Reports",
    viewLabel: "Report view",
    views: {
      totals: "Totals",
      entries: "Entries",
    },
  },

  /** The range picker the reports and the invoice dialog share. */
  rangePicker: {
    /** The other presets are `common.time.*`. */
    last5Years: "Last 5 years",
    allTime: "All time",
    selectDates: "Select dates",
    from: "From",
    to: "To",
    invalid: "From is after To — the range is not applied yet.",
  },

  /** A project's progress against its estimate and budget. */
  budget: {
    /** An estimate in hours; `{hours}` is an already formatted number. */
    hoursTarget: "{hours}h",
    /** "62h 5m of 80h", "€4,650.00 of €6,000.00". */
    progress: "{spent} of {target}",
    left: "{amount} left",
    over: "{amount} over",
    nearlyUsedUp: "Nearly used up",
    overBudget: "Over budget",
    /** `{currencies}` is a formatted list: "USD and EUR". */
    trackedIn: "Tracked in {currencies}. Amounts are never summed across currencies.",
    excludes: "Excludes {currencies} tracked before the workspace currency changed.",
    hoursMeter: "Tracked hours against the estimate",
    amountMeter: "Billable amount against the budget",
    /** Screen-reader value of a meter: "78% — 17h 55m left". */
    meterValue: "{percent} — {remainder}",
  },

  /** The filter bar every report shares. */
  filters: {
    allEntries: "All entries",
    searchDescriptions: "Search descriptions",
    clients: {
      empty: "No clients yet.",
      search: "Search clients…",
      edit: "Edit client",
      create: "New client…",
    },
    projects: {
      empty: "No projects yet.",
      search: "Search projects…",
      edit: "Edit project",
      create: "New project…",
    },
    tasks: {
      empty: "No tasks yet.",
      search: "Search tasks…",
      edit: "Edit task",
      create: "New task…",
    },
  },

  multiSelect: {
    noMatches: "No matches.",
    search: "Search…",
    /** Accessible name of the pencil on a row: "Edit client Acme". */
    editOption: "{action} {name}",
    clearSelected: "Clear {count, number} selected",
  },

  /** Grouping names, keyed by `ReportGroupBy`. */
  groupBy: {
    label: "Group by",
    breakdownTitle:
      "{groupBy, select, project {Breakdown by project} client {Breakdown by client} task {Breakdown by task} tag {Breakdown by tag} member {Breakdown by member} day {Breakdown by day} week {Breakdown by week} other {Breakdown by month}}",
    breakdownAria:
      "{groupBy, select, project {Share of tracked time by project} client {Share of tracked time by client} task {Share of tracked time by task} tag {Share of tracked time by tag} member {Share of tracked time by member} day {Share of tracked time by day} week {Share of tracked time by week} other {Share of tracked time by month}}",
    totalsTitle:
      "{groupBy, select, project {Totals by project} client {Totals by client} task {Totals by task} tag {Totals by tag} member {Totals by member} day {Totals by day} week {Totals by week} other {Totals by month}}",
  },

  kpi: {
    totalTracked: "Total tracked",
    amountEarned: "Amount earned",
    /** `{percent}` is formatted: "62%". */
    shareOfTracked: "{percent} of tracked time",
    wholeRange: "Whole filtered range",
    entriesLoaded: "Entries loaded",
    moreAvailable: "More available",
    allInRange: "All entries in range",
  },

  charts: {
    timelineTitle: {
      day: "Daily activity",
      week: "Weekly activity",
      month: "Monthly activity",
    },
    timelineAria: {
      day: "{count, plural, one {Tracked time across # day} other {Tracked time across # days}}",
      week: "{count, plural, one {Tracked time across # week} other {Tracked time across # weeks}}",
      month:
        "{count, plural, one {Tracked time across # month} other {Tracked time across # months}}",
    },
    /** Y-axis tick; `{hours}` is formatted. */
    hourTick: "{hours}h",
    /** Tooltip heading for a week bucket; `{date}` is formatted. */
    weekOf: "Week of {date}",
    tracked: "Tracked",
    /** "1:30:00 (12.5%)". */
    durationWithShare: "{duration} ({share})",
    /** Screen-reader line of a slice tooltip. */
    sliceSummary: "{label}: {duration}, {amount}",
    /** The slice that folds the smallest groups together. */
    more: "{count, number} more",
    timelineEmptyTitle: "No time in this range",
    timelineEmptyDescription:
      "Track some time or widen the date range to see the breakdown over time.",
    breakdownEmptyTitle: "Nothing to break down",
    breakdownEmptyDescription: "No tracked time matches the current filters.",
  },

  /** The trail of drill-down steps under the filter bar, and its Back button. */
  drill: {
    /** Accessible name of the trail. */
    trail: "Drill-down path",
    /** The first crumb: the report before any step. */
    root: "Whole report",
    /** Title of a crumb that can be returned to. */
    returnTo: "Back to {name}",
    /** Title of a legend row and the last line of a chart tooltip. */
    narrowTo: "Narrow the report to {name}",
    hint: "Click to narrow the report",
  },

  summary: {
    overlapNote:
      "An entry carrying several tags counts in each of them, so these rows add up to more than the total below.",
    share: "Share",
    budget: "Budget",
    lifetime: "(lifetime)",
    showEntriesFor: "Show time entries for {name}",
    emptyTitle: "No time tracked in this range",
    emptyDescription:
      "Adjust the filters or track some time, and the numbers will show up here.",
  },

  detailed: {
    selectAll: "Select all loaded entries",
    selectEntry: "Select entry {description}",
    selectEntryUntitled: "Select entry without description",
    sortBy: "Sort by {label}",
    startEnd: "Start / End",
    noDescription: "No description",
    editProject: "Edit project “{name}”",
    running: "running",
    loadMore: "Load more",
    emptyTitle: "No entries match these filters",
    emptyDescription:
      "Widen the date range, clear a filter, or track some time to populate this log.",
    toast: {
      removedProject:
        "{count, plural, one {Removed the project from # entry} other {Removed the project from # entries}}",
      moved:
        "{count, plural, one {Moved # entry to {project}} other {Moved # entries to {project}}}",
      theProject: "the project",
      markedBillable:
        "{count, plural, one {Marked # entry billable} other {Marked # entries billable}}",
      markedNonBillable:
        "{count, plural, one {Marked # entry non-billable} other {Marked # entries non-billable}}",
      deleted: "{count, plural, one {Deleted # entry} other {Deleted # entries}}",
      failed: "Bulk update failed",
    },
  },

  bulk: {
    region: "Bulk actions",
    setProject: "Set project",
    markBillable: "Mark billable",
    markNonBillable: "Mark non-billable",
    clearSelection: "Clear selection",
    confirmTitle:
      "{count, plural, one {Delete # time entry?} other {Delete # time entries?}}",
    confirmDescription:
      "This permanently removes the selected entries and the time they recorded. It cannot be undone.",
    confirm: "{count, plural, one {Delete entry} other {Delete entries}}",
  },


  exportMenu: {
    title: "Export report",
    csv: "Download CSV",
    pdf: "Download PDF",
    /** `{format}` is "CSV" or "PDF". */
    unsupported:
      "This app can't save files yet — open the report in a browser to download the {format}.",
    exported: "Exported {filename}",
    failed: "Could not export the report",
  },

  invoices: {
    description:
      "Bill a client for a range of tracked time. Time that has already been invoiced is never offered a second time.",
    count: "{count, plural, one {# invoice} other {# invoices}}",
    newInvoice: "New invoice",
    newBlankInvoice: "New blank invoice",
    emptyTitle: "No invoices yet",
    emptyDescription:
      "An invoice turns one client's billable time over one date range into a document. Time that lands on an invoice is never offered for billing again.",
    /**
     * Status names as the badge shows them. English keeps them lower-case,
     * the way the stored value reads.
     */
    status: {
      draft: "draft",
      sent: "sent",
      paid: "paid",
    },
    markAs:
      "{status, select, draft {Mark as draft} sent {Mark as sent} other {Mark as paid}}",
    backTo:
      "{status, select, draft {Back to draft} sent {Back to sent} other {Back to paid}}",
    columns: {
      number: "Number",
      issued: "Issued",
      due: "Due",
      status: "Status",
      billedRange: "Billed range",
      language: "Language",
      line: "Line",
      hours: "Hours",
      /** Replaces "Hours" once a manual line is on the invoice; every cell then names its unit. */
      quantity: "Quantity",
      unit: "Unit",
      /** Replaces "Rate" beside "Quantity": the price of one unit. */
      unitPrice: "Price",
    },
    /** Decimal hours on an invoice; `{hours}` is formatted: "3.00 h". */
    hoursValue: "{hours} h",
    /** A quantity with its unit; `{quantity}` is formatted, `{count}` is the same number for the plural. */
    quantityValue:
      "{quantity} {unit, select, hour {h} day {{count, plural, one {day} other {days}}} piece {{count, plural, one {pc} other {pcs}}} other {{unit}}}",
    /** The unit picker's options. */
    units: {
      hour: "Hours",
      day: "Days",
      piece: "Pieces",
    },
    billedHours: "Billed hours",
    subtotal: "Subtotal",
    noTax: "No tax",
    /** `{rate}` is a formatted percentage: "Tax (19%)". */
    tax: "Tax ({rate})",
    languages: {
      en: "English",
      de: "Deutsch",
    },

    detail: {
      close: "Close invoice",
      /** The billed-range cell of a blank invoice. */
      noRange: "No billed range",
      editDraft: "Edit draft",
      entriesNone: "No time entries are billed on this invoice.",
      entriesDraft:
        "{count, plural, one {# time entry is billed on this invoice and cannot be billed again unless this draft is deleted.} other {# time entries are billed on this invoice and cannot be billed again unless this draft is deleted.}}",
      entriesFinal:
        "{count, plural, one {# time entry is billed on this invoice and cannot be billed again.} other {# time entries are billed on this invoice and cannot be billed again.}}",
      downloadPdf: "Download PDF",
      deleteDraft: "Delete draft",
      deleteTitle: "Delete draft {number}?",
      deleteDescription:
        "{count, plural, one {The # entry on it becomes billable again, and the number is given up. Only drafts can be deleted — once an invoice is sent it is a record.} other {The # entries on it become billable again, and the number is given up. Only drafts can be deleted — once an invoice is sent it is a record.}}",
    },

    toast: {
      created: "Invoice {number} created.",
      /** `{status}` is the translated status name. */
      statusChanged: "Invoice {number} is now {status}.",
      deleted:
        "{count, plural, one {Draft deleted — # time entry is billable again.} other {Draft deleted — # time entries are billable again.}}",
      createFailed: "Could not create the invoice.",
      statusFailed: "Could not change the status.",
      deleteFailed: "Could not delete the invoice.",
      pdfFailed: "Could not build the PDF for {number}.",
      saved: "Draft {number} saved.",
      saveFailed: "Could not save the draft.",
    },

    /** The line editor: manual lines on a new invoice, and every line of a draft. */
    lines: {
      addLine: "Add line",
      removeLine: "Remove line {label}",
      labelPlaceholder: "Description",
      timeLineHint:
        "A time line takes its hours and rate from the entries it bills; only its description can change here.",
      additional: "Additional lines",
      additionalHint: "Fixed fees, expenses, anything not tracked as time.",
      empty: "No lines yet.",
      errors: {
        label: "Enter a description.",
        quantity: "Enter a quantity above 0 with at most 3 decimals.",
        unitPrice: "Enter a price of 0 or more with at most 2 decimals.",
      },
    },

    /** Editing a draft in place. */
    edit: {
      title: "Edit draft {number}",
      number: "Number",
      save: "Save changes",
      cancel: "Discard changes",
      nothingChanged: "Nothing changed yet.",
      invalidLines: "Fix the highlighted lines before saving.",
      invalidNumber: "Enter an invoice number.",
      invalidDates: "The due date cannot be before the issue date.",
      conflict: "This draft changed in another window. Reload it and make your changes again.",
      reload: "Reload",
      numberTaken: "This number is already used by another invoice.",
      notDraft: "Only a draft can be edited. This invoice has been sent.",
      einvoiceIssued: "An e-invoice was issued from this draft, so it can no longer be edited.",
    },

    notices: {
      missingRate:
        "{count, plural, one {# entry has no hourly rate and cannot be billed. Set a rate on the project, then re-run this preview.} other {# entries have no hourly rate and cannot be billed. Set a rate on the project, then re-run this preview.}}",
      alreadyInvoiced:
        "{count, plural, one {# entry is already on an earlier invoice and will not be billed again.} other {# entries are already on an earlier invoice and will not be billed again.}}",
    },

    emptyReason: {
      both: "Every billable hour in this range is either already invoiced or missing a rate.",
      invoiced:
        "Every billable hour in this range has already been invoiced. The same time is never billed twice.",
      missingRate:
        "The tracked time in this range carries no hourly rate, so there is nothing to bill.",
      none: "No billable, un-invoiced time was tracked for this client in this range.",
    },

    form: {
      title: "New invoice",
      description:
        "Preview costs nothing and changes nothing. Creating the invoice bills the time on it — that time can never be invoiced again.",
      blankTitle: "New blank invoice",
      blankDescription:
        "An invoice with lines you type yourself: no tracked time and no billed range. Tracked time stays billable.",
      addLinesForPreview: "Add at least one complete line to see the preview.",
      /** The confirmation strip of an invoice that bills no tracked time. */
      confirmNoEntries:
        "This creates invoice <b>{number}</b> for <b>{client}</b> at <b>{total}</b>. It bills no tracked time.",
      selectClient: "Select a client",
      lines: "Lines",
      perProject: "One line per project",
      perTask: "One line per task",
      taxRate: "Tax rate (%)",
      taxHint: "Leave empty for no tax line. 0 prints a real 0% line.",
      taxNotNumber: "Enter a tax rate as a number, e.g. 19.",
      taxOutOfRange: "A tax rate has to be between 0 and 100.",
      issueDate: "Issue date",
      dueDate: "Due date",
      notes: "Notes (optional)",
      notesPlaceholder: "Payment terms, a reference, anything the customer needs to see.",
      language: "Invoice language",
      /** The default choice; `{language}` names the language it resolves to. */
      languageAuto: "Automatic ({language})",
      languageHint:
        "Automatic uses the client's language, then yours. The invoice keeps its language after it is created.",
      preview: "Preview",
      nextNumber: "Next number: {number}",
      pickClient: "Pick a client to see what would be billed.",
      fixTax: "Fix the tax rate to see the preview.",
      gathering: "Gathering billable time…",
      nothingToBill: "Nothing to bill. {reason}",
      confirm:
        "This creates invoice <b>{number}</b> for <b>{client}</b> at <b>{total}</b> and bills {count, plural, one {# entry} other {# entries}}. That time cannot be invoiced again.",
      backToPreview: "Back to preview",
      createNumbered: "Create invoice {number}",
      create: "Create invoice…",
    },
  },
} as const;
