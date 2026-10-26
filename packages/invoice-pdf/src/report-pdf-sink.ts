/** Portable binary destination; the server adapts its backpressured stream. */
export type ReportPdfSink = {
  write: (chunk: Uint8Array) => void;
  ready: () => Promise<void>;
};
export function reportPdfByteSink(): ReportPdfSink & { bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  let length = 0;
  return {
    write: (chunk) => { chunks.push(chunk); length += chunk.byteLength; },
    ready: async () => {},
    bytes: () => {
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    },
  };
}
