export class PrivateContentUnavailableError extends Error {
  readonly privateContentRefusal = true;
  /** The tRPC code a standard workspace would answer with, where a screen branches on it (invoice edits). */
  /** E-invoice refusal details, as a server puts them on `error.data` (private-invoice-refusal.ts). */
  constructor(message = "Unlock private data and restore this device's trusted workspace inventory before continuing", readonly code?: string, readonly details?: { einvoiceIssues?: unknown[]; einvoiceFillRefusal?: string }) { super(message); this.name = "PrivateContentUnavailableError"; }
}
/** Local refusals stay refusals even when tRPC/durable wrappers add causes or
 * the radio is offline. They must never trigger a legacy plaintext enqueue. */
export function isPrivateContentRefusal(input: unknown): boolean {
  let error = input;
  for (let depth = 0; depth < 5 && error !== null && typeof error === "object"; depth++) {
    if ((error as { privateContentRefusal?: unknown }).privateContentRefusal === true) return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}
