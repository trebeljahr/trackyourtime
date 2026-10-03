import { createConnection, type Socket } from "node:net";
import nodemailer, { type SendMailOptions } from "nodemailer";

/** One delivery fits inside the server's 20-second drain window. */
export const EMAIL_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Own the socket so an absolute deadline stops SMTP itself, including DNS,
 * greeting, TLS, and DATA. Nodemailer's transport.close() does not stop an
 * active non-pooled send; rejecting a separate timer promise is insufficient.
 * A server may have accepted DATA before the connection failed: callers must
 * retain their existing at-least-once delivery semantics.
 */
export async function sendSmtpWithDeadline(
  options: { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } },
  message: SendMailOptions,
  timeoutMs = EMAIL_DELIVERY_TIMEOUT_MS,
): Promise<void> {
  let socket: Socket | undefined;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    socket?.destroy(new Error("SMTP delivery deadline exceeded"));
  }, timeoutMs);
  timeout.unref();
  const transport = nodemailer.createTransport({
    ...options,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
    getSocket: (_options, callback) => {
      if (expired) {
        callback(new Error("SMTP delivery deadline exceeded"));
        return;
      }
      socket = createConnection({ host: options.host, port: options.port });
      let handedOff = false;
      socket.once("error", (error) => {
        if (!handedOff) callback(error);
      });
      socket.once("connect", () => {
        handedOff = true;
        // Nodemailer still owns STARTTLS/implicit TLS and certificate checks.
        callback(null, { connection: socket });
      });
    },
  });
  try {
    await transport.sendMail(message);
  } finally {
    clearTimeout(timeout);
    socket?.destroy();
    transport.close();
  }
}
