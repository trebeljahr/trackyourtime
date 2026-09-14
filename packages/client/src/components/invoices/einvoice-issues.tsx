"use client";

import * as React from "react";
import Link from "next/link";
import {
  UNFIXABLE_EINVOICE_ISSUE_CODES,
  type EinvoiceIssue,
  type EinvoiceIssueCode,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  groupIssues,
  issueDisplayText,
  issueHref,
} from "@/components/einvoice/billing-fields";
import { useLocale } from "@/i18n/locale-store";
import { useT } from "@/i18n/use-t";

/** Codes fixed by copying today's data onto the invoice: they open the fill dialog. */
const FILL_CODES: ReadonlySet<EinvoiceIssueCode> = new Set([
  "SELLER_SNAPSHOT_MISSING",
  "BUYER_SNAPSHOT_MISSING",
  "LINE_TAX_MISSING",
]);

export type EinvoiceIssuesProps = {
  issues: readonly EinvoiceIssue[];
  invoiceId: string;
  /** The client's display name, for the client group heading. */
  clientName: string;
  /** Drafts can be deleted and re-created; issued invoices cannot. */
  isDraft: boolean;
  /** Opens the fill dialog; omitted where the list is already inside it. */
  onFill?: (() => void) | null;
  /** Downloads the plain PDF (offered beside a totals mismatch). */
  onDownloadPdf?: (() => void) | null;
  /** "einvoice-issues", "einvoice-refusal" or "einvoice-fill-remaining". */
  testIdPrefix: string;
  /**
   * An e-invoice was already issued from this snapshot, so nothing can be
   * filled or fixed on it: every issue says so instead of offering a link.
   */
  locked?: boolean;
};

/** Issues grouped by where they are fixed, each with the way to fix it. */
export function EinvoiceIssues({
  issues,
  invoiceId,
  clientName,
  isDraft,
  onFill = null,
  onDownloadPdf = null,
  testIdPrefix,
  locked = false,
}: EinvoiceIssuesProps): React.JSX.Element {
  const t = useT("einvoice");
  const language = useLocale();
  const groups = groupIssues(issues);

  // The catalog is typed against every known code; the server's sentence
  // wins where it is more precise (a named line, a quoted stored value), and
  // for a code a newer server sent.
  const text = (issue: EinvoiceIssue): string =>
    issueDisplayText(
      issue,
      language,
      (code) => t(`issues.codes.${code}`),
      (line, lineText) => t("issues.lineRef", { line: String(line), text: lineText }),
    );

  const action = (issue: EinvoiceIssue): React.ReactNode => {
    if (locked) {
      return (
        <span className="text-xs text-muted-foreground" data-testid="einvoice-issue-locked">
          {t("issues.frozenLocked")}
        </span>
      );
    }
    const href = issueHref(issue, { invoiceId });
    if (href !== null) {
      return (
        <Button asChild variant="link" size="sm" className="h-auto px-0" data-testid="einvoice-fix-link">
          <Link href={href}>
            {issue.fixIn === "businessProfile" ? t("issues.fixSettings") : t("issues.fixClient")}
          </Link>
        </Button>
      );
    }
    if (FILL_CODES.has(issue.code) && onFill) {
      return (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={onFill}
          data-testid="einvoice-fill-action"
        >
          {t("issues.fillAction")}
        </Button>
      );
    }
    if (issue.code === "TOTALS_MISMATCH" && onDownloadPdf) {
      return (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={onDownloadPdf}
          data-testid="einvoice-issue-download-pdf"
        >
          {t("issues.downloadPdf")}
        </Button>
      );
    }
    if (UNFIXABLE_EINVOICE_ISSUE_CODES.has(issue.code) || issue.fixIn === "invoice") {
      return (
        <span className="text-xs text-muted-foreground" data-testid="einvoice-issue-frozen">
          {isDraft ? t("issues.frozenDraft") : t("issues.frozenIssued")}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="space-y-3" data-testid={testIdPrefix}>
      {groups.map((group) => (
        <div key={group.fixIn} className="space-y-1.5" data-testid={`${testIdPrefix}-group`} data-fix-in={group.fixIn}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.fixIn === "clientBilling"
              ? t("issues.groups.clientBilling", { client: clientName })
              : t(`issues.groups.${group.fixIn}`)}
          </h4>
          <ul className="space-y-1.5">
            {group.issues.map((issue, index) => (
              <li
                key={`${issue.code}:${issue.field}:${index}`}
                className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                data-testid={`${testIdPrefix}-item`}
                data-code={issue.code}
                data-field={issue.field}
              >
                <span>
                  {text(issue)}
                  {issue.rule ? (
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground" title={issue.rule}>
                      {issue.rule}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0">{action(issue)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
