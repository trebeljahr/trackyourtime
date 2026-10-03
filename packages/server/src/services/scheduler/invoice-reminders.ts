import { serverT } from "../../i18n/index.js";
import { randomUUID } from "node:crypto";
import {
  canUseInvoices,
  currencyScale,
  invoiceBalance,
  nextReminderDay,
  REMINDER_DAYS,
  type Invoice as InvoiceWire,
} from "@starter/shared";
import { Invoice, toClientInvoice } from "../../models/Invoice.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import {
  isEmailDeliveryConfigured,
  sendEmail,
  type EmailParams,
} from "../email.js";
import { invoiceRefusal, revisionFilter } from "../invoice-follow-through.js";
import { registerRecurringJob } from "./registry.js";
import { publishSync } from "../../ws/sync.js";

export const INVOICE_REMINDER_JOB = "invoice-reminders";
const LEASE_MS = 10 * 60_000;
export function previewInvoiceReminder(
  invoice: InvoiceWire,
  recipient: string,
  timezone: string,
  now: Date,
): EmailParams & {
  schedule: number[];
  scheduledDates: string[];
  nextStage: number | null;
  outstandingMinor: number;
} {
  const balance = invoiceBalance({ ...invoice, timezone }, now);
  if (!balance.available) throw invoiceRefusal("invoice-balance-unavailable");
  const amount = new Intl.NumberFormat(invoice.locale ?? "en", {
    style: "currency",
    currency: invoice.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.log10(currencyScale(invoice.currency)),
  }).format(balance.outstandingMinor / currencyScale(invoice.currency));
  const t = serverT(invoice.locale ?? "en", "email");
  const subject = t("invoiceReminder.subject", { number: invoice.number });
  const message = t("invoiceReminder.body", {
    number: invoice.number,
    amount,
    date: invoice.dueDate.slice(0, 10),
  });
  const issuer = invoice.issuer;
  const payment = [
    issuer?.legalName,
    issuer?.email,
    issuer?.paymentDetails,
    issuer?.iban,
    issuer?.bic,
    issuer?.bankName,
    issuer?.accountHolder,
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${message}\n\n${payment}`;
  return {
    to: recipient,
    subject,
    text,
    ...(invoice.issuer?.email ? { replyTo: invoice.issuer.email } : {}),
    schedule: [...REMINDER_DAYS],
    scheduledDates: REMINDER_DAYS.map((day) =>
      new Date(Date.parse(invoice.dueDate.slice(0, 10)) + day * 86_400_000)
        .toISOString()
        .slice(0, 10),
    ),
    nextStage: nextReminderDay(
      {
        ...invoice,
        timezone,
        followThrough: {
          ...invoice.followThrough,
          reminders: {
            ...invoice.followThrough?.reminders,
            enabled: true,
            recipient,
            timezone,
            consentAt: now.toISOString(),
            consentBy: "",
            sentDays: invoice.followThrough?.reminders?.sentDays ?? [],
          },
        },
      },
      now,
    ),
    outstandingMinor: balance.outstandingMinor,
  };
}
export type InvoiceReminderDependencies = {
  now: () => Date;
  send: (mail: EmailParams) => Promise<void>;
  configured: () => boolean;
  beforeRecheck?: () => Promise<void>;
};
/** Injectable clock and mailer: tests never touch the configured real transport. */
export async function runInvoiceReminders(
  deps: InvoiceReminderDependencies,
): Promise<void> {
  let cursor: import("mongoose").Types.ObjectId | undefined;
  // Cursor batches bound memory without starving later invoice ids.
  while (true) {
    const candidates = await Invoice.find({
      "followThrough.reminders.enabled": true,
      status: { $in: ["sent", "paid"] },
      deleting: { $ne: true },
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    if (!candidates.length) break;
    for (const candidate of candidates) {
      const now = deps.now();
      const wire = toClientInvoice(candidate);
      const reminder = candidate.followThrough?.reminders;
      if (!reminder) continue;
      const day = nextReminderDay(
        { ...wire, timezone: reminder.timezone },
        now,
      );
      if (day === null) continue;
      // At most one attempt per invoice per hour, including delivery failures.
      if (
        reminder.lastAttemptAt &&
        now.getTime() - Date.parse(reminder.lastAttemptAt) < 3_600_000
      )
        continue;
      if (reminder.claim && Date.parse(reminder.claim.until) > now.getTime())
        continue;
      const token = randomUUID();
      const claimed = await Invoice.findOneAndUpdate(
        {
          _id: candidate._id,
          workspaceId: candidate.workspaceId,
          ...revisionFilter(candidate),
          "followThrough.reminders.enabled": true,
        },
        {
          $set: {
            "followThrough.reminders.claim": {
              token,
              day,
              until: new Date(now.getTime() + LEASE_MS).toISOString(),
            },
          },
          $inc: { followThroughRevision: 1 },
        },
        { returnDocument: "after" },
      ).lean();
      if (!claimed) continue;
      const filter = {
        _id: candidate._id,
        workspaceId: candidate.workspaceId,
        "followThrough.reminders.claim.token": token,
      };
      let outcome: "sent" | "failed" | "cancelled" = "cancelled";
      let failure: string | undefined;
      try {
        // Re-read consent, settlement, credit and membership immediately before handing anything to mail.
        await deps.beforeRecheck?.();
        const claimedConsent = claimed.followThrough?.reminders;
        const member = claimedConsent
          ? await WorkspaceMember.findOne({
              workspaceId: candidate.workspaceId,
              userId: claimedConsent.consentBy,
            }).lean()
          : null;
        const fresh = await Invoice.findOne(filter).lean();
        const consent = fresh?.followThrough?.reminders;
        const sendable =
          fresh &&
          consent?.enabled &&
          member &&
          member.userId === consent.consentBy &&
          canUseInvoices(member.role, member) &&
          nextReminderDay(
            { ...toClientInvoice(fresh), timezone: consent.timezone },
            deps.now(),
          ) === day;
        if (sendable && consent) {
          if (!deps.configured()) throw new Error("transport-unavailable");
          // Provider acceptance is not guaranteed inbox delivery. A process crash after
          // SMTP acceptance can be retried; we deliberately make no exactly-once claim.
          await deps.send(
            previewInvoiceReminder(
              toClientInvoice(fresh),
              consent.recipient,
              consent.timezone,
              deps.now(),
            ),
          );
          outcome = "sent";
        }
      } catch {
        outcome = "failed";
        failure = "invoice-reminder-delivery-failed";
      }
      await Invoice.updateOne(filter, {
        $set: {
          "followThrough.reminders.lastOutcome": outcome,
          "followThrough.reminders.lastAttemptAt": deps.now().toISOString(),
          ...(failure ? { "followThrough.reminders.failure": failure } : {}),
          ...(outcome === "cancelled"
            ? { "followThrough.reminders.enabled": false }
            : {}),
        },
        $unset: {
          "followThrough.reminders.claim": "",
          ...(!failure ? { "followThrough.reminders.failure": "" } : {}),
        },
        ...(outcome === "sent"
          ? {
              $addToSet: {
                "followThrough.reminders.sentDays": day,
                "followThrough.reminders.skippedDays": {
                  $each: REMINDER_DAYS.filter(
                    (stage) =>
                      stage < day && !reminder.sentDays.includes(stage),
                  ),
                },
              },
            }
          : {}),
        $inc: { followThroughRevision: 1 },
      });
      void publishSync(candidate.workspaceId, {
        kind: "invoice.changed",
        id: String(candidate._id),
      });
    }
    cursor = candidates[candidates.length - 1]!._id;
    if (candidates.length < 100) break;
  }
}
export function registerInvoiceReminderJob(): void {
  registerRecurringJob(INVOICE_REMINDER_JOB, 5 * 60_000, async () =>
    runInvoiceReminders({
      now: () => new Date(),
      send: sendEmail,
      configured: isEmailDeliveryConfigured,
    }),
  );
}
