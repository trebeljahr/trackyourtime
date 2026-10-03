"use client";

import * as React from "react";
import { currencyScale, invoiceDay, type Invoice } from "@starter/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/use-t";
import { useFormat } from "@/i18n/use-format";
import { trpc } from "@/lib/trpc";
import { downloadBase64 } from "@/lib/download";
import {
  entryMutationScope,
  sameEntryMutationScope,
} from "@/lib/entry-mutation-result";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { toast } from "@/components/ui/sonner";

type FollowThroughProps = {
  invoice: Invoice;
  onSelect: (id: string) => void;
  scopeKey?: string;
};

/** A scope/selection change discards drafts and pending-response authority together. */
export function InvoiceFollowThrough(
  props: FollowThroughProps,
): React.JSX.Element {
  return (
    <InvoiceFollowThroughBody
      key={JSON.stringify([
        props.scopeKey,
        props.invoice.workspaceId,
        props.invoice.id,
      ])}
      {...props}
    />
  );
}
function InvoiceFollowThroughBody({
  invoice,
  onSelect,
  scopeKey,
}: FollowThroughProps): React.JSX.Element {
  const t = useT("reports");
  const f = useFormat();
  const utils = trpc.useUtils();
  const pay = trpc.invoices.recordPayment.useMutation();
  const credit = trpc.invoices.credit.useMutation();
  const reminders = trpc.invoices.setReminders.useMutation();
  const [amount, setAmount] = React.useState("");
  const [at, setAt] = React.useState(() =>
    invoiceDay(new Date(), invoice.timezone ?? "UTC"),
  );
  const [note, setNote] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const reminder = invoice.followThrough?.reminders;
  const [recipient, setRecipient] = React.useState(
    reminder?.recipient ?? invoice.recipient?.email ?? "",
  );
  const [timezone, setTimezone] = React.useState(
    reminder?.timezone ?? invoice.timezone ?? "UTC",
  );
  const [enabled, setEnabled] = React.useState(reminder?.enabled ?? false);
  const [preview, setPreview] = React.useState<{
    subject: string;
    text: string;
    to: string;
    scheduledDates?: string[];
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const previewGeneration = React.useRef(0);
  const mounted = React.useRef(true);
  const [operationScope] = React.useState(entryMutationScope);
  React.useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = (): boolean =>
    mounted.current && sameEntryMutationScope(operationScope);
  // Keep the same request id after a lost response. Successful writes clear the key.
  const requests = React.useRef(new Map<string, string>());
  const requestId = (key: string): string => {
    const prior = requests.current.get(key);
    if (prior) return prior;
    const id = crypto.randomUUID();
    requests.current.set(key, id);
    return id;
  };
  const run = async (
    action: () => Promise<unknown>,
    key?: string,
    write = true,
  ): Promise<void> => {
    if (inFlight.current || !isCurrent()) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
      if (!isCurrent()) return;
      if (key) requests.current.delete(key);
      if (write) {
        // The server confirmed this write. A cache refresh cannot undo it.
        toast.success(t("followThrough.saved"));
        try {
          await utils.invoices.invalidate();
        } catch {
          if (isCurrent()) toast.error(t("followThrough.refreshFailed"));
        }
      }
    } catch {
      if (isCurrent()) toast.error(t("followThrough.error"));
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  const record = (
    kind: "payment" | "refund" | "reversal",
    value = amount,
    reverses?: string,
  ): void => {
    const key = JSON.stringify({
      scopeKey,
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      kind,
      value,
      at,
      note,
      reverses,
    });
    void run(async () => {
      await pay.mutateAsync({
        id: invoice.id,
        requestId: requestId(key),
        kind,
        amount: value,
        at: `${at}T00:00:00.000Z`,
        note,
        ...(reverses ? { reverses } : {}),
        originId: ORIGIN_ID,
      });
      if (isCurrent()) setAmount("");
    }, key);
  };
  const issueCredit = (replacement: boolean): void => {
    const key = JSON.stringify({
      scopeKey,
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      reason,
      replacement,
    });
    void run(async () => {
      const result = await credit.mutateAsync({
        id: invoice.id,
        requestId: requestId(key),
        reason,
        replacement,
        originId: ORIGIN_ID,
      });
      if (isCurrent() && result.followThrough?.credit?.replacementId)
        onSelect(result.followThrough.credit.replacementId);
    }, key);
  };
  const balance = invoice.balance;
  const fullCredit = invoice.followThrough?.credit;
  const scale = currencyScale(invoice.currency);
  const money = (minor: number): string =>
    f.number(minor / scale, {
      style: "currency",
      currency: invoice.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.log10(scale),
    });
  const canRemind =
    invoice.status !== "draft" &&
    !fullCredit &&
    (balance?.outstandingMinor ?? 0) > 0;
  const payments = invoice.followThrough?.payments ?? [];
  if (balance?.available === false)
    return (
      <section
        className="border-t pt-4"
        data-testid="invoice-balance-unavailable"
      >
        <p role="status">{t("followThrough.balanceUnavailable")}</p>
      </section>
    );
  return (
    <section
      className="space-y-4 border-t pt-4"
      data-testid="invoice-follow-through"
    >
      <h3 className="font-semibold">{t("followThrough.heading")}</h3>
      {invoice.replacementFor ? (
        <p className="text-sm">{t("followThrough.replacementInfo")}</p>
      ) : null}
      <dl className="flex flex-wrap gap-6 text-sm">
        <div>
          <dt>{t("followThrough.outstanding")}</dt>
          <dd>{money(balance?.outstandingMinor ?? 0)}</dd>
        </div>
        <div>
          <dt>{t("followThrough.received")}</dt>
          <dd>{money(balance?.paidMinor ?? 0)}</dd>
        </div>
        {(balance?.refundDueMinor ?? 0) > 0 ? (
          <div>
            <dt>{t("followThrough.refundDue")}</dt>
            <dd>{money(balance?.refundDueMinor ?? 0)}</dd>
          </div>
        ) : null}
        {(balance?.overdueDays ?? 0) > 0 ? (
          <div className="text-destructive">
            {t("followThrough.overdue")}: {balance?.overdueDays}
          </div>
        ) : null}
      </dl>
      {balance?.legacySettled ? (
        <p className="text-sm text-muted-foreground">
          {t("followThrough.legacy")}
        </p>
      ) : null}
      <h4 className="text-sm font-medium">
        {t("followThrough.paymentHistory")}
      </h4>
      {payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("followThrough.noHistory")}
        </p>
      ) : (
        <ul className="space-y-2">
          {payments.map((p) => (
            <li
              key={p.requestId}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span>
                {t(`followThrough.${p.kind}`)} · {p.at.slice(0, 10)} ·{" "}
                {money(p.amountMinor)} · {p.note}
              </span>
              {p.kind !== "reversal" &&
              !payments.some((row) => row.reverses === p.requestId) &&
              (p.kind === "refund" ||
                (balance?.paidMinor ?? 0) >= p.amountMinor) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    record(
                      "reversal",
                      (p.amountMinor / scale).toFixed(Math.log10(scale)),
                      p.requestId,
                    )
                  }
                >
                  {t(
                    p.kind === "refund"
                      ? "followThrough.reverseRefund"
                      : "followThrough.reverse",
                  )}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {invoice.status !== "draft" &&
      ((balance?.outstandingMinor ?? 0) > 0 ||
        (balance?.refundDueMinor ?? 0) > 0) ? (
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            record(fullCredit ? "refund" : "payment");
          }}
        >
          <label className="text-sm">
            {t("followThrough.amount")}
            <Input
              data-testid="invoice-payment-amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="text-sm">
            {t("followThrough.date")}
            <Input
              type="date"
              required
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <label className="text-sm">
            {t("followThrough.note")}
            <Input
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Button disabled={busy} data-testid="invoice-record-payment">
            {t(
              fullCredit
                ? "followThrough.recordRefund"
                : "followThrough.recordPayment",
            )}
          </Button>
          {fullCredit ? (
            <p className="text-sm sm:col-span-3">
              {t("followThrough.refundHelp")}
            </p>
          ) : null}
        </form>
      ) : null}
      {fullCredit ? (
        <div className="space-y-2">
          <p>
            {t("followThrough.credited", { number: fullCredit.number })} ·{" "}
            {fullCredit.reason}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("followThrough.xmlUnsupported")}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                async () => {
                  const pdf = await utils.invoices.exportCreditPdf.fetch({
                    id: invoice.id,
                  });
                  if (isCurrent())
                    downloadBase64(pdf.filename, pdf.base64, pdf.mimeType);
                },
                undefined,
                false,
              )
            }
          >
            {t("followThrough.downloadCredit")}
          </Button>
          {fullCredit.replacementId ? (
            <>
              <Button
                variant="outline"
                onClick={() => onSelect(fullCredit.replacementId!)}
              >
                {t("followThrough.replacement")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    credit.mutateAsync({
                      id: invoice.id,
                      requestId: fullCredit.requestId,
                      reason: fullCredit.reason,
                      replacement: true,
                      originId: ORIGIN_ID,
                    }),
                  )
                }
              >
                {t("followThrough.repairReplacement")}
              </Button>
            </>
          ) : null}
        </div>
      ) : invoice.status !== "draft" ? (
        <div className="space-y-2">
          <label className="block text-sm">
            {t("followThrough.reason")}
            <Input
              data-testid="invoice-credit-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("followThrough.creditConfirm")}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !confirmed || !reason.trim()}
              onClick={() => issueCredit(false)}
            >
              {t("followThrough.credit")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !confirmed || !reason.trim()}
              onClick={() => issueCredit(true)}
            >
              {t("followThrough.correct")}
            </Button>
          </div>
        </div>
      ) : null}
      {canRemind || reminder ? (
        <div className="space-y-3">
          <h4 className="font-medium">{t("followThrough.reminders")}</h4>
          <p className="text-sm text-muted-foreground">
            {t("followThrough.policy")}
          </p>
          <label className="block text-sm">
            {t("followThrough.recipient")}
            <Input
              type="email"
              value={recipient}
              onChange={(e) => {
                previewGeneration.current++;
                setRecipient(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label className="block text-sm">
            {t("followThrough.timezone")}
            <Input
              value={timezone}
              onChange={(e) => {
                previewGeneration.current++;
                setTimezone(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!canRemind}
              checked={enabled && canRemind}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("followThrough.consent")}
          </label>
          <Button
            variant="outline"
            disabled={busy || !recipient}
            onClick={() =>
              void run(
                async () => {
                  const generation = previewGeneration.current;
                  const result = await utils.invoices.reminderPreview.fetch({
                    id: invoice.id,
                    enabled,
                    recipient,
                    timezone,
                  });
                  if (isCurrent() && generation === previewGeneration.current)
                    setPreview(result);
                },
                undefined,
                false,
              )
            }
          >
            {t("followThrough.preview")}
          </Button>
          {preview ? (
            <div
              className="rounded border p-3 text-sm"
              data-testid="invoice-reminder-preview"
            >
              <p>{preview.to}</p>
              <strong>{preview.subject}</strong>
              <p className="whitespace-pre-wrap">{preview.text}</p>
              <p>{t("followThrough.schedule", { days: "1 / 7 / 14" })}</p>
              <p>{preview.scheduledDates?.join(" / ")}</p>
              <p>{t("followThrough.lateReminder")}</p>
            </div>
          ) : null}
          {enabled && !preview ? (
            <p className="text-sm">{t("followThrough.previewRequired")}</p>
          ) : null}
          <Button
            disabled={busy || !recipient || (enabled && canRemind && !preview)}
            onClick={() =>
              void run(() =>
                reminders.mutateAsync({
                  id: invoice.id,
                  enabled: enabled && canRemind,
                  recipient,
                  timezone,
                  originId: ORIGIN_ID,
                }),
              )
            }
          >
            {t("followThrough.save")}
          </Button>
          {reminder?.lastOutcome ? (
            <p className="text-sm" role="status">
              {t("followThrough.lastOutcome", {
                outcome: t(
                  reminder.lastOutcome === "sent"
                    ? "followThrough.outcomeSent"
                    : reminder.lastOutcome === "failed"
                      ? "followThrough.outcomeFailed"
                      : "followThrough.outcomeCancelled",
                ),
                date: reminder.lastAttemptAt ?? "—",
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
