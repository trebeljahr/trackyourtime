/**
 * Where an export's bytes go.
 *
 * A report export is written in pages: the writer produces one page of rows,
 * hands the bytes to `write`, and awaits `ready` before it asks the database
 * for the next page. That await is the whole memory bound. Against an HTTP
 * response it waits for `drain`, so a client reading slowly makes the server
 * produce slowly, and what is held at any moment is one page of rows plus
 * whatever the socket has not taken yet — not the report.
 *
 * Two sinks: one over a `Writable` (the response), and one that collects into
 * memory for the tRPC procedures, which must return the whole file as JSON.
 */
import type { Writable } from "node:stream";

export type ExportSink = {
  /**
   * Never throws: pdfkit calls it from its "data" events, some of them on a
   * later tick, where a throw would be uncaught. Writes to a destination that
   * has gone are dropped, and the next `ready()` says so.
   */
  write: (chunk: string | Buffer) => void;
  /**
   * Resolves once the destination wants more. Rejects with
   * {@link ExportAbortedError} when it went away or stopped reading.
   */
  ready: () => Promise<void>;
};

/** The destination closed, errored or stalled; stop producing. */
export class ExportAbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ExportAbortedError";
  }
}

/**
 * How long a reader may take nothing before the export is abandoned. A
 * client that opens a download and never reads would otherwise hold the
 * export — and its slot — open for as long as the socket lives.
 */
export const EXPORT_STALL_MS = 60_000;

/** A sink over a `Writable`, honouring its backpressure. */
export function writableSink(
  destination: Writable,
  options: { stallMs?: number } = {},
): ExportSink {
  const stallMs = options.stallMs ?? EXPORT_STALL_MS;
  const gone = (): boolean =>
    destination.destroyed || destination.writableEnded;

  return {
    write: (chunk) => {
      if (!gone()) destination.write(chunk);
    },
    ready: () => {
      if (gone()) {
        return Promise.reject(new ExportAbortedError("destination closed"));
      }
      if (!destination.writableNeedDrain) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const settle = (error: Error | null): void => {
          clearTimeout(timer);
          destination.off("drain", onDrain);
          destination.off("close", onClose);
          destination.off("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onDrain = (): void => settle(null);
        const onClose = (): void =>
          settle(new ExportAbortedError("destination closed"));
        const onError = (error: Error): void =>
          settle(new ExportAbortedError(error.message));
        const timer = setTimeout(
          () => settle(new ExportAbortedError("destination stalled")),
          stallMs,
        );
        destination.on("drain", onDrain);
        destination.on("close", onClose);
        destination.on("error", onError);
      });
    },
  };
}

export type BufferSink = ExportSink & {
  /** Everything written so far, as one Buffer. */
  buffer: () => Buffer;
};

/** A sink that keeps every byte — for callers that need the whole file. */
export function bufferSink(): BufferSink {
  const chunks: Buffer[] = [];
  return {
    write: (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    },
    ready: () => Promise.resolve(),
    buffer: () => Buffer.concat(chunks),
  };
}
