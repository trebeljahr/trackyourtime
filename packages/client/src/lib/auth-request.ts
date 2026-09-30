/** Bound native auth waits without depending on newer AbortSignal helpers. */
export async function fetchAuthWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abort);
  }
}
