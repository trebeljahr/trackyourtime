"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { INVOICE_LINE_UNITS, type InvoiceLineUnit } from "@starter/shared";

import { NativeSelect } from "@/components/einvoice/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import {
  invalidManualLines,
  lineAmount,
  newManualLineDraft,
  type EditableLine,
  type ManualLineField,
} from "./line-editor";
import { formatQuantity } from "./types";

export type ManualLinesEditorProps = {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  currency: string;
  /** Prefix for every test id. */
  testIdPrefix: string;
  /** A VAT control per line, rendered in its own column when given. */
  renderLineTax?: ((line: { key: string; label: string }, index: number) => React.ReactNode) | null;
  disabled?: boolean;
};

/**
 * The lines of an invoice as a table of inputs.
 *
 * A time line shows its figures read-only and takes only a new description:
 * its hours and rate are what the entries it bills add up to, and the server
 * refuses anything else. A manual line is four inputs and an amount computed
 * beside them with the same arithmetic the server stores, so the figure on
 * screen is the figure that will be saved. Quantities and prices are kept as
 * typed until the line is checked, so "1," is not rounded under the cursor.
 */
export function ManualLinesEditor({
  lines,
  onChange,
  currency,
  testIdPrefix,
  renderLineTax = null,
  disabled = false,
}: ManualLinesEditorProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const te = useT("einvoice");
  const f = useFormat();
  const invalid = invalidManualLines(lines);
  // A row is highlighted once it was touched: a fresh, empty line is not an
  // error until the person moves on from it.
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set());

  const patch = (key: string, change: Partial<EditableLine>): void => {
    onChange(lines.map((line) => (line.key === key ? ({ ...line, ...change } as EditableLine) : line)));
  };
  const touch = (key: string): void => {
    setTouched((current) => (current.has(key) ? current : new Set(current).add(key)));
  };
  const remove = (key: string): void => onChange(lines.filter((line) => line.key !== key));
  const add = (): void => onChange([...lines, newManualLineDraft()]);

  const errorsOf = (key: string): ManualLineField[] =>
    touched.has(key) ? (invalid.get(key) ?? []) : [];
  const hasTimeLines = lines.some((line) => line.kind === "time");

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-editor`}>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("invoices.columns.line")}</TableHead>
              <TableHead className="w-28 text-right">{t("invoices.columns.quantity")}</TableHead>
              <TableHead className="w-28">{t("invoices.columns.unit")}</TableHead>
              <TableHead className="w-32 text-right">{t("invoices.columns.unitPrice")}</TableHead>
              {renderLineTax ? <TableHead className="w-40">{te("lines.vatColumn")}</TableHead> : null}
              <TableHead className="w-28 text-right">{tc("fields.amount")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={renderLineTax ? 7 : 6} className="text-center text-sm text-muted-foreground">
                  {t("invoices.lines.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {lines.map((line, index) => {
              const amount = lineAmount(line);
              const errors = errorsOf(line.key);
              const rowId = `${testIdPrefix}-row-${index}`;
              return (
                <TableRow key={line.key} data-testid={rowId} data-kind={line.kind}>
                  <TableCell className="align-top">
                    <Input
                      value={line.label}
                      placeholder={t("invoices.lines.labelPlaceholder")}
                      aria-label={t("invoices.columns.line")}
                      aria-invalid={errors.includes("label")}
                      disabled={disabled}
                      onChange={(event) => patch(line.key, { label: event.target.value })}
                      onBlur={() => touch(line.key)}
                      data-testid={`${rowId}-label`}
                    />
                    {errors.includes("label") ? (
                      <p className="mt-1 text-xs text-destructive">{t("invoices.lines.errors.label")}</p>
                    ) : null}
                  </TableCell>
                  {line.kind === "time" ? (
                    <>
                      <TableCell className="text-right tabular-nums align-top pt-4" data-testid={`${rowId}-quantity`}>
                        {formatQuantity(line.original, f.locale)}
                      </TableCell>
                      <TableCell className="align-top pt-4 text-muted-foreground">
                        {t("invoices.units.hour")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top pt-4 text-muted-foreground">
                        {f.money(line.original.hourlyRate, currency)}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="align-top">
                        <Input
                          inputMode="decimal"
                          className="text-right"
                          value={line.quantity}
                          aria-label={t("invoices.columns.quantity")}
                          aria-invalid={errors.includes("quantity")}
                          disabled={disabled}
                          onChange={(event) => patch(line.key, { quantity: event.target.value })}
                          onBlur={() => touch(line.key)}
                          data-testid={`${rowId}-quantity`}
                        />
                        {errors.includes("quantity") ? (
                          <p className="mt-1 text-xs text-destructive">{t("invoices.lines.errors.quantity")}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <NativeSelect
                          value={line.unit}
                          aria-label={t("invoices.columns.unit")}
                          disabled={disabled}
                          onChange={(event) =>
                            patch(line.key, { unit: event.target.value as InvoiceLineUnit })
                          }
                          data-testid={`${rowId}-unit`}
                        >
                          {INVOICE_LINE_UNITS.map((unit) => (
                            <option key={unit} value={unit}>
                              {t(`invoices.units.${unit}`)}
                            </option>
                          ))}
                        </NativeSelect>
                      </TableCell>
                      <TableCell className="align-top">
                        <Input
                          inputMode="decimal"
                          className="text-right"
                          value={line.unitPrice}
                          aria-label={t("invoices.columns.unitPrice")}
                          aria-invalid={errors.includes("unitPrice")}
                          disabled={disabled}
                          onChange={(event) => patch(line.key, { unitPrice: event.target.value })}
                          onBlur={() => touch(line.key)}
                          data-testid={`${rowId}-unit-price`}
                        />
                        {errors.includes("unitPrice") ? (
                          <p className="mt-1 text-xs text-destructive">{t("invoices.lines.errors.unitPrice")}</p>
                        ) : null}
                      </TableCell>
                    </>
                  )}
                  {renderLineTax ? (
                    <TableCell className="align-top">{renderLineTax(line, index)}</TableCell>
                  ) : null}
                  <TableCell
                    className={cn("text-right tabular-nums align-top pt-4", amount === null && "text-muted-foreground")}
                    data-testid={`${rowId}-amount`}
                  >
                    {amount === null ? "—" : f.money(amount, currency)}
                  </TableCell>
                  <TableCell className="align-top">
                    {line.kind === "manual" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        aria-label={t("invoices.lines.removeLine", { label: line.label || String(index + 1) })}
                        onClick={() => remove(line.key)}
                        data-testid={`${rowId}-remove`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={add}
          data-testid={`${testIdPrefix}-add`}
        >
          <Plus className="size-4" />
          {t("invoices.lines.addLine")}
        </Button>
        {hasTimeLines ? (
          <p className="text-xs text-muted-foreground">{t("invoices.lines.timeLineHint")}</p>
        ) : null}
      </div>
    </div>
  );
}
