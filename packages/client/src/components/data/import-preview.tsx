"use client";

import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import {
  IMPORT_DAY_START_HOUR,
  type ImportColumnRole,
  type ImportDateOrder,
  type ImportPreview,
} from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { isImportColumnRole, ROLE_OPTIONS } from "./roles";

export type ImportPreviewViewProps = {
  preview: ImportPreview;
  /** Re-point one column; the caller re-analyzes with the override applied. */
  onRoleChange: (index: number, role: ImportColumnRole) => void;
  onDateOrderChange: (order: ImportDateOrder) => void;
  busy: boolean;
};

/** A sample row's start: a moment, not a day. */
const SHORT_MOMENT = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
} as const satisfies Intl.DateTimeFormatOptions;

/** How many new catalog names are listed before the rest become a count. */
const NAME_LIST_LIMIT = 8;

/** One number and what it counts. */
function Stat(props: {
  label: string;
  value: string;
  tone?: "default" | "muted";
}): React.JSX.Element {
  return (
    <div className="rounded-lg border p-3">
      <div
        className={
          props.tone === "muted"
            ? "text-xl font-semibold text-muted-foreground"
            : "text-xl font-semibold"
        }
      >
        {props.value}
      </div>
      <div className="text-xs text-muted-foreground">{props.label}</div>
    </div>
  );
}

function Note(props: {
  tone: "info" | "warning";
  testId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const Icon = props.tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      data-testid={props.testId}
      className={
        props.tone === "warning"
          ? "flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          : "flex gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>{props.children}</div>
    </div>
  );
}


/**
 * What the file would do, before it does it.
 *
 * The mapping table is editable because detection is a guess: every column
 * carries the role it was given and the first value it holds, so the guess can
 * be checked against the data rather than against the header alone.
 */
export function ImportPreviewView({
  preview,
  onRoleChange,
  onDateOrderChange,
  busy,
}: ImportPreviewViewProps): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();
  const unreadable = preview.totalRows - preview.readyRows - preview.duplicateRows;

  const shortDate = (iso: string | null): string =>
    iso === null ? "—" : f.date(iso, "medium") || "—";

  /** A list of names, truncated with a count once it stops being readable. */
  const nameList = (names: readonly string[]): string => {
    if (names.length === 0) return tc("status.none");
    if (names.length <= NAME_LIST_LIMIT) return f.list(names);
    return t("data.preview.namesAndMore", {
      names: names.slice(0, NAME_LIST_LIMIT).join(", "),
      count: names.length - NAME_LIST_LIMIT,
    });
  };

  const dayStart = new Date(2000, 0, 1, IMPORT_DAY_START_HOUR, 0);

  return (
    <div className="space-y-4" data-testid="import-preview">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t("data.preview.stats.ready", { count: preview.readyRows })}
          value={f.number(preview.readyRows)}
        />
        <Stat
          label={t("data.preview.stats.duplicates")}
          value={f.number(preview.duplicateRows)}
          tone="muted"
        />
        <Stat
          label={t("data.preview.stats.unreadable", { count: Math.max(0, unreadable) })}
          value={f.number(Math.max(0, unreadable))}
          tone="muted"
        />
        <Stat
          label={t("data.preview.stats.trackedTime")}
          value={f.durationShort(preview.totalSec)}
        />
      </div>

      <p className="text-sm text-muted-foreground" data-testid="import-range">
        {preview.readyRows === 0
          ? t("data.preview.nothingNew")
          : t("data.preview.range", {
              from: shortDate(preview.firstStart),
              to: shortDate(preview.lastStart),
              timeZone: preview.timeZone,
            })}
      </p>

      {preview.dateOrderAmbiguous ? (
        <Note tone="warning">
          {t.rich("data.preview.ambiguousDates", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </Note>
      ) : null}

      {preview.sections.newerVersion !== null ? (
        <Note tone="warning" testId="import-newer-version">
          {t.rich("data.preview.newerVersion", {
            version: String(preview.sections.newerVersion),
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </Note>
      ) : null}

      {preview.sections.moneyRedacted ? (
        <Note tone="warning" testId="import-money-redacted">
          {t.rich("data.preview.moneyRedacted", {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </Note>
      ) : null}

      {preview.sections.invoices > 0 ? (
        <Note tone="info" testId="import-invoices-dropped">
          {t("data.preview.invoicesDropped", { count: preview.sections.invoices })}
        </Note>
      ) : null}

      {preview.shape === "date-duration" ? (
        <Note tone="info">
          {t("data.preview.dateDuration", { time: f.time(dayStart) })}
        </Note>
      ) : null}

      {preview.columns.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{t("data.preview.columns.title")}</h4>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("data.preview.dateOrder.label")}
              <Select
                value={preview.dateOrder}
                onValueChange={(value) => {
                  if (value === "dmy" || value === "mdy" || value === "ymd") {
                    onDateOrderChange(value);
                  }
                }}
                disabled={busy}
              >
                <SelectTrigger
                  className="h-8 w-56"
                  aria-label={t("data.preview.dateOrder.ariaLabel")}
                  data-testid="import-date-order"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["dmy", "mdy", "ymd"] as const).map((order) => (
                    <SelectItem key={order} value={order}>
                      {t(`data.preview.dateOrder.${order}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("data.preview.columns.column")}</TableHead>
                  <TableHead>{t("data.preview.columns.firstValue")}</TableHead>
                  <TableHead className="w-56">
                    {t("data.preview.columns.importedAs")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.columns.map((column) => (
                  <TableRow key={column.index}>
                    <TableCell className="font-medium">
                      {column.header ||
                        t("data.preview.columns.unnamed", { number: String(column.index + 1) })}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">
                      {column.sample ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={column.role}
                        onValueChange={(value) => {
                          if (isImportColumnRole(value)) {
                            onRoleChange(column.index, value);
                          }
                        }}
                        disabled={busy}
                      >
                        <SelectTrigger
                          className="h-8"
                          aria-label={t("data.preview.columns.roleFor", {
                            column:
                              column.header ||
                              t("data.preview.columns.unnamed", {
                                number: String(column.index + 1),
                              }),
                          })}
                          data-testid={`import-column-${column.index}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((role) => (
                            <SelectItem key={role} value={role}>
                              {t(`data.roles.${role}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      <div className="space-y-1 text-sm">
        <h4 className="font-medium">{t("data.preview.creates.title")}</h4>
        <ul className="text-muted-foreground">
          <li data-testid="import-new-clients">
            {t("data.preview.creates.clients", { names: nameList(preview.newClients) })}
          </li>
          <li data-testid="import-new-projects">
            {t("data.preview.creates.projects", { names: nameList(preview.newProjects) })}
          </li>
          <li>
            {t("data.preview.creates.tasks", { count: preview.newTasks.length })}
          </li>
          <li data-testid="import-new-tags">
            {t("data.preview.creates.tags", { names: nameList(preview.newTags) })}
          </li>
        </ul>
      </div>

      {preview.sample.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            {t("data.preview.sample.title", { count: preview.sample.length })}
          </h4>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tc("fields.start")}</TableHead>
                  <TableHead>{t("data.preview.sample.length")}</TableHead>
                  <TableHead>{tc("fields.description")}</TableHead>
                  <TableHead>{tc("fields.project")}</TableHead>
                  <TableHead>{tc("fields.tags")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.sample.map((row) => (
                  <TableRow key={row.row}>
                    <TableCell className="whitespace-nowrap">
                      {f.date(row.start, SHORT_MOMENT)}
                    </TableCell>
                    <TableCell>{f.durationShort(row.durationSec)}</TableCell>
                    <TableCell className="max-w-64 truncate">
                      {row.description || (
                        <span className="text-muted-foreground">
                          {t("data.preview.sample.noDescription")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{row.projectName ?? "—"}</TableCell>
                    <TableCell className="space-x-1">
                      {row.tagNames.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      {preview.issues.length > 0 ? (
        <details className="rounded-md border p-3" data-testid="import-issues">
          <summary className="cursor-pointer text-sm font-medium">
            {t("data.preview.issues.title", { count: preview.issues.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {preview.issues.map((item) => (
              <li key={`${item.row}-${item.code}`}>
                {t("data.preview.issues.row", {
                  row: String(item.row),
                  message: item.message,
                })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
