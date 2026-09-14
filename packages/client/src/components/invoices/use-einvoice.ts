"use client";

import * as React from "react";
import {
  EINVOICE_FILL_REFUSAL_CODES,
  type AttachEinvoiceDataInput,
  type EinvoiceCheckResult,
  type EinvoiceFillRefusalCode,
  type EinvoiceIssue,
  type EinvoiceProfile,
} from "@starter/shared";

import { errorCode, errorMessage } from "@/components/catalog/types";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { trpc } from "@/lib/trpc";
import type { InvoiceRow } from "./types";

/**
 * Typed read of `error.data.einvoiceIssues`, which the server's error
 * formatter copies from an e-invoice refusal. null for any other error.
 */
export function einvoiceIssuesFromError(error: unknown): EinvoiceIssue[] | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const issues = (data as { einvoiceIssues?: unknown }).einvoiceIssues;
  if (!Array.isArray(issues)) return null;
  return issues.filter(
    (issue): issue is EinvoiceIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { code?: unknown }).code === "string" &&
      typeof (issue as { field?: unknown }).field === "string" &&
      typeof (issue as { fixIn?: unknown }).fixIn === "string",
  );
}

/**
 * The stable code of a fill refusal that lists no issues
 * (`error.data.einvoiceFillRefusal`). null for any other error, and for a code
 * this client does not know.
 */
export function einvoiceFillRefusalFromError(error: unknown): EinvoiceFillRefusalCode | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { einvoiceFillRefusal?: unknown }).einvoiceFillRefusal;
  return (EINVOICE_FILL_REFUSAL_CODES as readonly unknown[]).includes(code)
    ? (code as EinvoiceFillRefusalCode)
    : null;
}

export type EinvoiceCheckState = {
  data: EinvoiceCheckResult | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * Readiness for one invoice and one profile. Runs only while the panel is
 * mounted, and `staleTime: 0` so a return from fixing the profile re-asks.
 */
export function useEinvoiceCheck(invoiceId: string, profile: EinvoiceProfile): EinvoiceCheckState {
  const query = trpc.invoices.einvoiceCheck.useQuery(
    { id: invoiceId, profile },
    { staleTime: 0, retry: false },
  );
  const { refetch } = query;
  return {
    data: query.data,
    isLoading: query.isPending,
    isError: query.isError,
    refetch: React.useCallback(() => void refetch(), [refetch]),
  };
}

export type AttachOutcome =
  | { kind: "attached"; invoice: InvoiceRow }
  | { kind: "refused"; issues: EinvoiceIssue[] }
  | { kind: "conflict"; message: string }
  | { kind: "declined"; code: EinvoiceFillRefusalCode }
  | { kind: "error"; message: string };

export type AttachEinvoiceVars = Omit<AttachEinvoiceDataInput, "originId">;

/** The only write on an issued invoice besides its status. Amounts never change. */
export function useAttachEinvoiceData(): {
  attach: (input: AttachEinvoiceVars) => Promise<AttachOutcome>;
  isPending: boolean;
} {
  const utils = trpc.useUtils();
  const mutation = trpc.invoices.attachEinvoiceData.useMutation({
    onSettled: () => {
      // No entries or reports: filling details never moves a figure.
      void utils.invoices.list.invalidate();
      void utils.invoices.get.invalidate();
      void utils.invoices.einvoiceCheck.invalidate();
    },
  });
  const { mutateAsync } = mutation;

  const attach = React.useCallback(
    async (input: AttachEinvoiceVars): Promise<AttachOutcome> => {
      try {
        const invoice = await mutateAsync({ ...input, originId: ORIGIN_ID });
        return { kind: "attached", invoice };
      } catch (error) {
        const issues = einvoiceIssuesFromError(error);
        if (issues !== null && issues.length > 0) return { kind: "refused", issues };
        const declined = einvoiceFillRefusalFromError(error);
        if (declined !== null) return { kind: "declined", code: declined };
        if (errorCode(error) === "CONFLICT") {
          return { kind: "conflict", message: errorMessage(error, "") };
        }
        return { kind: "error", message: errorMessage(error, "") };
      }
    },
    [mutateAsync],
  );

  return { attach, isPending: mutation.isPending };
}
