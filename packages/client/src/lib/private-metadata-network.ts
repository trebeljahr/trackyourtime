/** Only transport failure may use an existing encrypted display copy. Auth,
 * application refusals and malformed data remain refusals. */
export function privateMetadataNetworkFailure(input: unknown) {
  const seen = new Set<unknown>(); let error = input, transport = false;
  for (let i = 0; i < 5 && error && typeof error === "object" && !seen.has(error); i++) {
    seen.add(error);
    if ((error as { data?: { code?: unknown } }).data?.code) return false;
    if (error instanceof TypeError) transport = true;
    error = (error as { cause?: unknown }).cause;
  }
  return error !== null && typeof error === "object" ? false : transport;
}
