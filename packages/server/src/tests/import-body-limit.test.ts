import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { trpcUploadJsonParser } from "../app.js";

describe("import HTTP body limits", () => {
  let server: Server;
  let base: string;
  before(async () => {
    const app = express();
    app.use("/api/trpc", trpcUploadJsonParser());
    app.use(express.json({ limit: "100kb" }));
    app.use((_req, res) => { res.sendStatus(204); });
    app.use(((error: { status?: number }, _req, res, _next) => {
      res.sendStatus(error.status ?? 500);
    }) satisfies express.ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function upload(path: string, batch = false) {
    const input = { text: "x".repeat(110 * 1024) };
    const response = await fetch(`${base}/api/trpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch ? { 0: input } : input),
    });
    await response.text();
    return response.status;
  }

  it("accepts a single import, including the client's single-item batch", async () => {
    assert.equal(await upload("data.analyze"), 204);
    assert.equal(await upload("data.commit?batch=1", true), 204);
  });

  it("does not lend import capacity to other endpoints or mixed batches", async () => {
    for (const path of [
      "entries.create",
      "data.analyzeExtra",
      "data.commit/entries.create",
      "entries.create,data.commit?batch=1",
      "data.analyze,data.commit?batch=1",
      "profile.setAvatar,entries.create?batch=1",
    ]) assert.equal(await upload(path, path.includes("batch")), 413, path);
  });
});
