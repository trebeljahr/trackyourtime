/**
 * English `catalog` messages — the SOURCE catalog for clients, projects, tasks and tags screens, pickers and dialogs.
 *
 * Add keys here first (grouped by component or screen, camelCase), then the
 * same keys in ../de/catalog.ts: `tsc` fails until both agree. ICU syntax:
 * `{name}`, `{count, plural, one {# entry} other {# entries}}`, `<b>…</b>`
 * with `t.rich`. Words every screen uses are already in `common`.
 */
export const catalog = {
  clientBilling: {
    toggle: "Billing details",
    toggleHint: "What an invoice prints under “Billed to”. All fields are optional.",
    legalName: "Legal name",
    addressLine: "Address line {line}",
    postalCode: "Postal code",
    city: "City",
    country: "Country code",
    taxId: "Tax ID",
    email: "Billing email",
    reference: "Reference",
    referenceHint: "The client’s own reference, such as a purchase order. On an e-invoice this is the buyer reference: public-sector clients in Germany give you a Leitweg-ID for it.",
    invalidCountry: "Enter a two-letter country code.",
    vatId: "VAT ID",
    vatIdHint: "Needed for reverse charge (AE).",
    legacyTaxId: "Tax ID printed so far",
    legacyTaxIdHint: "Invoices print this text. A reverse-charge e-invoice needs it as a VAT ID.",
    useAsVatId: "Use as VAT ID",
    electronicAddressHint: "Where this client receives e-invoices. Leave it empty to use the billing email.",
    preferredFormat: "Invoice format",
    preferredFormatHint: "The download an invoice for this client offers first.",
    defaultTax: "Default VAT category",
    defaultTaxHint: "Selected on new invoices for this client.",
    suggestion: "Suggested for these countries: {category}",
    useSuggestion: "Use",
    backToInvoice: "Back to the invoice",
  },
  /** The frame every manage screen shares (catalog-screen.tsx). */
  screen: {
    showArchived: "Show archived",
    loadError: "Could not load the catalog. Check your connection and try again.",
  },
  /** Pieces every catalog table row uses. */
  row: {
    /** Menu trigger of one row, e.g. "Actions for Acme". */
    actions: "Actions for {name}",
    /** Appended to an archived row's name in a picker. */
    archivedName: "{name} (archived)",
    /** Small inline marker next to an archived option. */
    archivedMarker: "archived",
    empty: "—",
  },
  columns: {
    tracked: "Tracked",
    entries: "Entries",
    billing: "Billing",
    budget: "Budget",
  },
  entriesLink: {
    title: "Show time entries for {name}",
    menuItem: "Show time entries",
  },
  form: {
    nameRequired: "Name is required",
    saveChanges: "Save changes",
  },
  /** The question after a billing change: does it reach time already booked? */
  applyToEntries: {
    title: "Update existing entries?",
    count:
      "{count, plural, one {# time entry on {project} keeps the billing it was saved with.} other {# time entries on {project} keep the billing they were saved with.}} New entries use the new billing either way.",
    flagChanged:
      "{count, plural, one {Updating marks it {billable, select, billable {billable} other {non-billable}}, including entries you changed by hand, and reprices it.} other {Updating marks every one of them {billable, select, billable {billable} other {non-billable}}, including entries you changed by hand, and reprices them.}} Report totals change to match.",
    rateOnly:
      "Updating reprices billable time. Each entry keeps its own billable flag. Report totals change to match.",
    invoiced:
      "{count, plural, one {# invoiced entry stays} other {# invoiced entries stay}} as billed.",
    newOnly: "Only new entries",
    accept: "Update {count, plural, one {# entry} other {# entries}}",
  },
  /** Toasts and inline errors from the catalog mutation hooks. */
  errors: {
    /** A CONFLICT from the server: the name is already used in this workspace. */
    nameTaken:
      "{kind, select, client {A client} project {A project} task {A task} other {A tag}} named “{name}” already exists.",
    createClient: "Could not create the client.",
    saveClient: "Could not save the client.",
    archiveClient: "Could not archive the client.",
    deleteClient: "Could not delete the client.",
    createProject: "Could not create the project.",
    saveProject: "Could not save the project.",
    archiveProject: "Could not archive the project.",
    deleteProject: "Could not delete the project.",
    createTask: "Could not add the task.",
    saveTask: "Could not save the task.",
    archiveTask: "Could not archive the task.",
    deleteTask: "Could not delete the task.",
    createTag: "Could not create the tag.",
    saveTag: "Could not save the tag.",
    deleteTag: "Could not delete the tag.",
    countEntries: "Could not count the entries on this project.",
  },
  /** The toast after a delete: what went with it, and what only lost a reference. */
  removal: {
    deleted: "{kind, select, client {Client} project {Project} other {Task}} deleted.",
    deletedWithDetail:
      "{kind, select, client {Client} project {Project} other {Task}} deleted — {detail}.",
    tasksDeleted: "{count, plural, one {# task} other {# tasks}} deleted",
    projectsDetached:
      "{count, plural, one {# project} other {# projects}} kept without a client",
    entriesDetached:
      "{count, plural, one {# time entry} other {# time entries}} kept without a {kind, select, client {client} project {project} other {task}}",
    favoritesDetached:
      "{count, plural, one {# favorite} other {# favorites}} kept without a {kind, select, client {client} project {project} other {task}}",
  },
  clients: {
    description:
      "Clients sit above projects and roll their tracked time together. Deleting one keeps its projects — they just become client-less.",
    new: "New client",
    search: "Search clients",
    editLabel: "Edit client “{name}”",
    empty: {
      title: "No clients yet",
      filteredTitle: "No clients match these filters",
      description: "Clients sit above projects and roll their tracked time together.",
      filteredDescription: "Try clearing the search, or turn on “Show archived”.",
    },
    delete: {
      title: "Delete “{name}”?",
      withProjects:
        "{projects, plural, one {Its project is kept. It loses the client and keeps its {entries, plural, one {# time entry} other {# time entries}}.} other {Its # projects are kept. They lose the client and keep their {entries, plural, one {# time entry} other {# time entries}}.}} Archive instead if you want to keep the client.",
      noProjects: "This client has no projects. Nothing else is affected.",
      confirm: "Delete client",
    },
    form: {
      titleNew: "New client",
      titleEdit: "Edit client",
      description: "Clients sit above projects and roll their tracked time together.",
      namePlaceholder: "Acme Inc.",
      create: "Create client",
      created: "Client “{name}” created.",
      saved: "Client saved.",
      invoiceLocale: {
        label: "Invoice language",
        /** The empty choice: resolveInvoiceLocale falls back to the issuer's own preference. */
        inherit: "Your language setting",
        /** Language names stay in their own language, as in the Settings picker. */
        en: "English",
        de: "Deutsch",
        hint: "Invoices for this client are written in this language. You can still pick another one on a single invoice.",
      },
    },
  },
  projects: {
    description:
      "Projects group tracked time and carry the billing defaults for new entries. Deleting one keeps its time entries — they just become project-less.",
    new: "New project",
    search: "Search projects or clients",
    editLabel: "Edit project “{name}”",
    summary:
      "{count, plural, one {# project} other {# projects}} · {duration} tracked",
    overBudget: "{count, number} over budget",
    clientFilter: {
      all: "All clients",
      search: "Filter by client...",
      empty: "No clients yet.",
    },
    empty: {
      title: "No projects yet",
      filteredTitle: "No projects match these filters",
      description:
        "Projects group tracked time and carry the billing defaults for new entries.",
      filteredDescription:
        "Try clearing the search or client filter, or turn on “Show archived”.",
    },
    noBudget: "No budget",
    delete: {
      title: "Delete “{name}”?",
      withEntries:
        "{count, plural, one {# time entry keeps its tracked time and becomes project-less.} other {# time entries keep their tracked time and become project-less.}} Tasks are not affected. Archive instead if you want to keep the project.",
      noEntries: "This project has no tracked time. Tasks are not affected.",
      confirm: "Delete project",
    },
    billing: {
      editLabel: "Edit billing for {name}",
      /** A rate per hour, e.g. "€80.00/h". */
      rate: "{amount}/h",
      /** Marks a rate the project inherits from the workspace. */
      defaultMarker: "default",
      billableByDefault: "Billable by default",
      hourlyRate: "Hourly rate ({currency})",
      ratePlaceholder: "Default: {amount}",
      rateInvalid: "Enter a rate of 0 or more, or leave it empty",
      rateHint: "Leave empty to use the workspace default.",
      nonBillableHint: "Non-billable time carries no rate.",
      saved: "Billing saved for new entries.",
      savedWithEntries:
        "Billing saved and {count, plural, one {# entry} other {# entries}} updated.",
    },
    form: {
      titleNew: "New project",
      titleEdit: "Edit project",
      description:
        "Projects group tracked time and carry the billing defaults for new entries.",
      namePlaceholder: "Website redesign",
      create: "Create project",
      created: "Project “{name}” created.",
      saved: "Project saved.",
      savedWithEntries:
        "Project saved and {count, plural, one {# entry} other {# entries}} updated.",
      client: {
        search: "Search or type a new name…",
        empty: "No clients yet.",
      },
      advanced: {
        toggle: "Billing & limits",
        summary: "Rate, targets, idle",
      },
      billableHint: "New entries on this project start as billable.",
      rateHint: "Leave empty to fall back to the workspace default rate.",
      targets: {
        legend: "Estimate & budget",
        hint: "Lifetime targets for the whole project, not a monthly allowance. Leave a field empty for no target — that is not the same as a target of zero.",
        estimate: "Estimated hours",
        estimatePlaceholder: "No estimate",
        estimateInvalid: "Enter hours of 0 or more, or leave it empty",
        budget: "Budget ({currency})",
        budgetInvalid: "Enter an amount of 0 or more, or leave it empty",
        currencyNote:
          "This budget is in {budgetCurrency}, the workspace currency when it was set. Time tracked in {currency} is reported separately rather than converted.",
      },
      idle: {
        label: "When you go idle",
        inherit: "Use the workspace setting",
        hint: "Pick “{keepRunning}” for work that produces no typing — meetings, calls, reading. It never switches idle detection on; that stays a workspace setting.",
        behaviors: {
          ask: "Ask me",
          pauseAndResume: "Pause and resume",
          keepRunning: "Keep running",
          stop: "Stop the timer",
        },
      },
    },
  },
  tasks: {
    description:
      "What the work is, independent of which project it was for. An entry can carry a task, a project, both or neither — deleting a task keeps the entries booked on it.",
    new: "New task",
    search: "Search tasks",
    editLabel: "Edit task “{name}”",
    markDone: "Mark {name} done",
    summary:
      "{count, plural, one {# task} other {# tasks}} · {open, number} open · {duration} tracked",
    empty: {
      title: "No tasks yet",
      filteredTitle: "No tasks match these filters",
      description:
        "Tasks name the kind of work. An entry can carry one, a project, both, or neither.",
      filteredDescription: "Try clearing the search, or turn on “Show archived”.",
    },
    delete: {
      title: "Delete “{name}”?",
      withTime:
        "Entries booked on this task keep their tracked time and their project — they simply lose the task.",
      noTime: "No time is tracked against this task.",
      confirm: "Delete task",
    },
    form: {
      titleNew: "New task",
      titleEdit: "Edit task",
      description:
        "Tasks name the kind of work, whichever project it happens on. An entry can carry one, a project, both, or neither.",
      namePlaceholder: "Write the launch post",
      create: "Create task",
      created: "Task “{name}” created.",
      saved: "Task saved.",
    },
  },
  tags: {
    description:
      "Labels that cut across the project tree. An entry can carry several, and archiving one keeps it on the time already tagged with it.",
    new: "New tag",
    editLabel: "Edit tag “{name}”",
    showArchived: "Show archived ({count, number})",
    empty: {
      title: "No tags yet",
      description:
        "Tags cut across projects — “on-site”, “bugfix”, “needs review”. Add one here, or coin it straight from the tracker bar.",
    },
    removal: {
      archiveTitle: "Archive “{name}”?",
      archiveDescription:
        "{count, plural, one {# time entry still carries this tag} other {# time entries still carry this tag}}, so it will be archived rather than deleted — the time keeps its label, and the tag stops being offered on new entries.",
      deleteTitle: "Delete “{name}”?",
      deleteDescription:
        "Nothing is tagged with it, so it will be deleted outright. This cannot be undone.",
    },
    deleted: "Tag deleted.",
    archivedInstead: "This tag is still on tracked time, so it was archived instead of deleted.",
    form: {
      titleNew: "New tag",
      titleEdit: "Edit tag",
      description: "A label that cuts across projects. One entry can carry several.",
      namePlaceholder: "needs review",
      created: "Tag “{name}” created.",
      saved: "Tag saved.",
    },
    picker: {
      search: "Search or create a tag...",
      empty: "No tags yet — type one to create it.",
      create: "Create “{name}”",
      remove: "Remove {count, plural, one {# tag} other {# tags}}",
      tooMany: "An entry can carry at most {max, plural, one {# tag} other {# tags}}.",
    },
    filter: {
      empty: "No tags yet.",
      search: "Search tags...",
      edit: "Edit tag",
      new: "New tag…",
    },
  },
  colorPicker: {
    pick: "Pick a colour",
    custom: "Custom colour",
    hex: "Hex colour",
  },
} as const;
