/**
 * English `report` — the SOURCE catalog for report PDF exports
 * (services/pdf.ts): titles, mastheads, KPI labels, column headers, empty
 * states.
 *
 * Add keys here, then the same keys in ../de/report.ts (`tsc` enforces it).
 * A report is rendered in the language of the person exporting it — their
 * explicit preference, else English — because nobody else will ever hold it.
 *
 * Every English message reproduces what the renderer printed before it was
 * localised (`pdf.test.ts` still reads those words). Figures arrive formatted
 * by `services/pdf-format.ts`; the messages only place them.
 *
 * Deliberately NOT here: CSV headers. A CSV is read back by this app's own
 * importer and by spreadsheets keyed on its column names, so it stays English
 * whatever the exporter's language.
 */
export const report = {
  title: {
    summary:
      "Summary report by {groupBy, select, project {project} client {client} task {task} tag {tag} member {member} day {day} week {week} month {month} other {{groupBy}}}",
    detailed: "Detailed report",
    weekly: "Weekly timesheet",
  },
  footer: {
    product: "Track Your Time · {timeZone}",
    page: "Page {page}",
  },
  /** `from`/`to` are formatted dates; `timeZone` an IANA zone name. */
  range: "{from} to {to} · time zone {timeZone}",
  amountsIn: "Amounts in {currency} · generated {generatedAt}",
  /** The masthead when the caller may not see money: no currency to name. */
  generated: "generated {generatedAt}",
  continued: "{from} to {to} · {timeZone} · continued",
  stats: {
    totalTracked: "Total tracked",
    billable: "Billable",
    amount: "Amount ({currency})",
    entries: "Entries",
    rows: "Rows",
    week: "Week",
  },
  weekRange: "{from} to {to}",
  columns: {
    group: "Group",
    duration: "Duration",
    billable: "Billable",
    amount: "Amount ({currency})",
    date: "Date",
    time: "Time",
    description: "Description",
    projectTask: "Project / Task",
    /** One letter: the column is a tick box, and anything wider costs the description. */
    billableShort: "B",
    total: "Total",
  },
  /** The tick in that column. */
  billableMark: "Y",
  empty: {
    range: "No time tracked in this range.",
    week: "No time tracked in this week.",
  },
  total: "Total",
  /** `start` is a clock time. */
  running: "{start} - running",
  noProject: "No project",
  noDescription: "(no description)",
  /** Summary group rows for entries with nothing assigned in that dimension. */
  unassigned: {
    project: "No project",
    client: "No client",
    task: "No task",
    tag: "No tag",
  },
  /** The labels the report query invents for a member-grouped row. */
  member: {
    former: "Former member",
    unnamed: "Unnamed member",
  },
} as const;
