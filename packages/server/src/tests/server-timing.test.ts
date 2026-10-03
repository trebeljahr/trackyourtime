import assert from "node:assert/strict";
import { it } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { allowServerTiming, timeServerWork } from "../middleware/server-timing.js";
import { router, workspaceProcedure } from "../trpc/trpc.js";
import type { Context } from "../trpc/context.js";

it("records actual workspace/data paths including parallel batch work and failures", async () => {
  const app = express();
  const api = router({ read: workspaceProcedure.query(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "private data";
  }) });
  app.get("/", async (_req, res) => {
    const ctx = { res, user: { id: "private-user" }, session: {},
      resolveRequestWorkspace: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { workspaceId: "private-workspace", membership: {}, visibility: {} };
      },
    } as unknown as Context;
    await timeServerWork(res, "auth", async () => {});
    const caller = api.createCaller(ctx);
    await Promise.all([caller.read(), caller.read()]);
    await assert.rejects(timeServerWork(res, "data", async () => { throw new Error("private error"); }));
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(response.status, 200);
    const header = response.headers.get("server-timing")!;
    assert.match(header, /^auth;dur=\d+\.\d, workspace;dur=\d+\.\d, data;dur=\d+\.\d$/);
    assert.ok(Number(/workspace;dur=([\d.]+)/.exec(header)![1]) >= 5);
    assert.ok(Number(/data;dur=([\d.]+)/.exec(header)![1]) >= 5);
    assert.ok(!header.includes("private"));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("allows Resource Timing only for the exact origin already approved by CORS", () => {
  for (const allowed of ["https://trusted.test", "*", undefined]) {
    const headers = new Map<string, unknown>([["Access-Control-Allow-Origin", allowed]]);
    let advanced = false;
    allowServerTiming({ headers: { origin: "https://trusted.test" } } as never, {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: unknown) => headers.set(name, value),
      vary: () => {},
    } as never, () => { advanced = true; });
    assert.equal(headers.get("Timing-Allow-Origin"), allowed === "https://trusted.test" ? allowed : undefined);
    assert.ok(advanced);
  }
});

it("does not change responses once headers are sent", async () => {
  await timeServerWork({ headersSent: true, setHeader: () => { throw new Error("late header"); } } as never,
    "auth", async () => {});
});
