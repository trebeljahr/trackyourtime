/**
 * Handing a generated file to the browser as a download.
 *
 * Lifted out of `components/reports/export-menu.tsx` so the CSV export, the
 * server-rendered PDF export and the invoice PDF all use one implementation
 * of the object-URL + anchor dance instead of three copies that drift.
 *
 * Everything here touches `document` and `URL.createObjectURL`, so it is
 * browser-only — call it from an event handler, never during render or from
 * anything that runs in the static export's build step.
 */

/** Hand an already-built Blob to the browser as a download. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking synchronously can race Safari's download start.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Decode base64 payload bytes into a Blob.
 *
 * Binary crosses tRPC base64-encoded because the transport is JSON (see
 * `PdfExportResult` in @starter/shared). `atob` yields a binary STRING, so
 * the bytes have to be copied into a `Uint8Array` one char code at a time —
 * passing that string straight to `new Blob([...])` would encode it as UTF-8
 * and silently corrupt every byte above 0x7f, which is most of a PDF.
 */
export function base64Blob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

/** Decode base64 payload bytes into a Blob and download it. */
export function downloadBase64(
  filename: string,
  base64: string,
  mimeType: string,
): void {
  downloadBlob(filename, base64Blob(base64, mimeType));
}
