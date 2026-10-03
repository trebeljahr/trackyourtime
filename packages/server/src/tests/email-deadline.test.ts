import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { it } from "node:test";
import { sendSmtpWithDeadline } from "../services/email-deadline.js";

async function smtpServer(accept: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    accept(socket);
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      server.listen(randomInt(49152, 65536), "127.0.0.1");
      await once(server, "listening");
      break;
    } catch (error) {
      if (attempt === 2 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, close: async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  } };
}
const message = { from: "sender@example.test", to: "recipient@example.test", subject: "Fixture", text: "Synthetic" };

it("SMTP deadline destroys a connection waiting forever for its greeting", { timeout: 3000 }, async () => {
  let closed = false;
  const server = await smtpServer((socket) => { socket.once("close", () => { closed = true; }); });
  try {
    await assert.rejects(sendSmtpWithDeadline({ host: "127.0.0.1", port: server.port, secure: false }, message, 100));
    await sleep(30);
    assert.equal(closed, true);
  } finally { await server.close(); }
});

it("SMTP deadline stops a send after DATA, without leaving a live socket", { timeout: 3000 }, async () => {
  let receivedData = false, closed = false;
  const server = await smtpServer((socket) => {
    socket.write("220 fixture ESMTP\r\n");
    let body = false, buffer = "";
    socket.once("close", () => { closed = true; });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (body) { if (buffer.includes("\r\n.\r\n")) receivedData = true; return; }
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line === "DATA") { body = true; socket.write("354 continue\r\n"); break; }
        socket.write("250 fixture\r\n");
      }
    });
  });
  try {
    await assert.rejects(sendSmtpWithDeadline({ host: "127.0.0.1", port: server.port, secure: false }, message, 200));
    await sleep(30);
    assert.equal(receivedData, true);
    assert.equal(closed, true);
  } finally { await server.close(); }
});

it("implicit TLS never sends plaintext mail through the supplied socket", { timeout: 3000 }, async () => {
  let bytes = Buffer.alloc(0), closed = false;
  const server = await smtpServer((socket) => {
    socket.once("close", () => { closed = true; });
    socket.on("data", (data) => { bytes = Buffer.concat([bytes, typeof data === "string" ? Buffer.from(data) : data]); });
  });
  try {
    await assert.rejects(sendSmtpWithDeadline({ host: "127.0.0.1", port: server.port, secure: true }, message, 150));
    await sleep(30);
    assert.ok(bytes.length > 0, "TLS handshake reached the peer");
    assert.equal(bytes[0], 22, "first packet is TLS handshake content");
    assert.equal(bytes.includes(Buffer.from("MAIL FROM")), false);
    assert.equal(closed, true);
  } finally { await server.close(); }
});


it("SMTP delivery succeeds and closes its owned connection", { timeout: 3000 }, async () => {
  let receivedData = false, closed = false;
  const server = await smtpServer((socket) => {
    socket.write("220 fixture ESMTP\r\n");
    let body = false, buffer = "";
    socket.once("close", () => { closed = true; });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (body) {
        if (buffer.includes("\r\n.\r\n")) {
          receivedData = true;
          socket.write("250 accepted\r\n");
          buffer = "";
          body = false;
        }
        return;
      }
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line === "DATA") { body = true; socket.write("354 continue\r\n"); break; }
        socket.write("250 fixture\r\n");
      }
    });
  });
  try {
    await sendSmtpWithDeadline({ host: "127.0.0.1", port: server.port, secure: false }, message, 1000);
    await sleep(30);
    assert.equal(receivedData, true);
    assert.equal(closed, true);
  } finally { await server.close(); }
});
