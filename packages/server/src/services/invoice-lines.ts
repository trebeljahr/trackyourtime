/**
 * Manual invoice lines and draft edits, as pure rules.
 *
 * A manual line is typed onto an invoice rather than rolled up from tracked
 * time: a quantity of a unit at a price. Two things about it are decided here
 * and nowhere else, so `create`, `preview` and `update` cannot disagree:
 *
 *  - Its `amount` is `manualLineAmount(quantity, unitPrice)` from
 *    `@starter/shared`, never a figure the client sent.
 *  - Its `key` is `manual:<id>` — the client's when it sent one (so a VAT
 *    choice can address the line before its first save), else a fresh one —
 *    and can never collide with a time line's key.
 *
 * A time line on a draft may only be relabelled: its seconds, rate and amount
 * are what the entries it claims add up to, and changing them here would make
 * the invoice disagree with the time it bills.
 */
import {
  isManualLineKey,
  manualLineAmount,
  newManualLineKey,
  lineKind,
  type InvoiceLineItem,
  type LineTax,
  type ManualInvoiceLineInput,
  type UpdateInvoiceInput,
} from "@starter/shared";

/** Lines as stored, plus the per-line VAT they asked for by key. */
export type BuiltLines = {
  lines: InvoiceLineItem[];
  /** `lineTax` entries, one per line that carried its own `tax`. */
  lineTax: Array<{ key: string } & LineTax>;
};

/** A refusal with a message the router turns into BAD_REQUEST. */
export class InvoiceLinesError extends Error {
  override readonly name = "InvoiceLinesError";
}

/** A manual line as stored: seconds and hours 0, `hourlyRate` mirrors the unit price for older readers. */
function manualLine(
  key: string,
  input: ManualInvoiceLineInput,
  currency: string,
): InvoiceLineItem {
  return {
    key,
    label: input.label,
    projectId: null,
    taskId: null,
    kind: "manual",
    seconds: 0,
    hours: 0,
    hourlyRate: input.unitPrice,
    currency,
    amount: manualLineAmount(input.quantity, input.unitPrice),
    quantity: input.quantity,
    unit: input.unit,
    unitPrice: input.unitPrice,
  };
}

/**
 * The manual lines of a request, keyed and priced. `taken` holds every key
 * already on the invoice (the time lines), so a client-chosen key that
 * repeats one is refused rather than silently doubled.
 */
export function manualLineItems(
  inputs: readonly ManualInvoiceLineInput[],
  currency: string,
  taken: ReadonlySet<string> = new Set(),
  nextKey: () => string = newManualLineKey,
): BuiltLines {
  const used = new Set(taken);
  const lines: InvoiceLineItem[] = [];
  const lineTax: BuiltLines["lineTax"] = [];
  for (const input of inputs) {
    let key = input.key;
    if (key !== undefined) {
      if (used.has(key)) throw new InvoiceLinesError(`Line key "${key}" is used twice.`);
    } else {
      do key = nextKey();
      while (used.has(key));
    }
    used.add(key);
    lines.push(manualLine(key, input, currency));
    if (input.tax) lineTax.push({ key, category: input.tax.category, rate: input.tax.rate });
  }
  return { lines, lineTax };
}

/**
 * The line list of a draft after an edit, in the order the edit gives.
 *
 * Every stored time line must appear exactly once (matched by key) and keeps
 * everything but its label; a manual line comes back as the edit describes
 * it, keyed as before or freshly, and a stored manual line the edit leaves
 * out is gone. Without `edits` the stored lines are kept as they are.
 */
export function mergeDraftLines(
  stored: readonly InvoiceLineItem[],
  edits: UpdateInvoiceInput["lines"],
  currency: string,
  nextKey: () => string = newManualLineKey,
): BuiltLines {
  if (edits === undefined) return { lines: stored.map((line) => ({ ...line })), lineTax: [] };

  const timeLines = new Map(
    stored.filter((line) => lineKind(line) === "time").map((line) => [line.key, line]),
  );
  const seen = new Set<string>();
  const lines: InvoiceLineItem[] = [];
  const lineTax: BuiltLines["lineTax"] = [];
  const taken = new Set(stored.map((line) => line.key));

  for (const edit of edits) {
    if (edit.kind === "time") {
      const line = timeLines.get(edit.key);
      if (!line) {
        throw new InvoiceLinesError(
          `Line "${edit.key}" is not a time line of this invoice. Time lines cannot be added here.`,
        );
      }
      if (seen.has(edit.key)) throw new InvoiceLinesError(`Line "${edit.key}" is listed twice.`);
      seen.add(edit.key);
      lines.push({ ...line, ...(edit.label === undefined ? {} : { label: edit.label }) });
      if (edit.tax) lineTax.push({ key: edit.key, category: edit.tax.category, rate: edit.tax.rate });
      continue;
    }
    // A manual key the edit reuses must not be a time line's, and must not
    // repeat within the edit; a key it invents must be a manual one.
    let key = edit.key;
    if (key !== undefined) {
      if (!isManualLineKey(key) || timeLines.has(key)) {
        throw new InvoiceLinesError(`"${key}" is not a manual line key.`);
      }
      if (seen.has(key)) throw new InvoiceLinesError(`Line "${key}" is listed twice.`);
    } else {
      do key = nextKey();
      while (taken.has(key) || seen.has(key));
    }
    seen.add(key);
    lines.push(manualLine(key, edit, currency));
    if (edit.tax) lineTax.push({ key, category: edit.tax.category, rate: edit.tax.rate });
  }

  const missing = [...timeLines.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new InvoiceLinesError(
      `Time lines cannot be removed from a draft (${missing.join(", ")}). Delete the draft to release their entries.`,
    );
  }
  return { lines, lineTax };
}
