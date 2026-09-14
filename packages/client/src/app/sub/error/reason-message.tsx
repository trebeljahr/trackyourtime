"use client";

import { useSearchParams } from "next/navigation";

import { useT } from "@/i18n/use-t";

/** The `reason` codes the confirm route redirects with, and their message keys. */
const REASONS = {
  missing: "missing",
  malformed: "malformed",
  bad_signature: "badSignature",
  expired: "expired",
  list_add_failed: "listAddFailed",
} as const;

type ReasonCode = keyof typeof REASONS;

const isReasonCode = (value: string | null): value is ReasonCode =>
  value !== null && Object.prototype.hasOwnProperty.call(REASONS, value);

/**
 * Read as a client-side search param rather than `await searchParams`: the
 * app is built with `output: "export"`, where a page that awaits
 * searchParams cannot be prerendered.
 */
export function ReasonMessage(): React.ReactElement {
  const t = useT("marketing");
  const reason = useSearchParams().get("reason");
  const message = isReasonCode(reason)
    ? t(`newsletter.error.reasons.${REASONS[reason]}`)
    : t("newsletter.error.reasons.fallback");

  return <p className="mt-4 text-gray-600">{message}</p>;
}
