import assert from "node:assert/strict";
import { after, beforeEach, it, mock } from "node:test";
import { TimeEntry } from "../models/TimeEntry.js";
import { projectsRouter } from "../trpc/routers/projects.js";
import { clientsRouter } from "../trpc/routers/clients.js";
import { tasksRouter } from "../trpc/routers/tasks.js";
import { OWNER, ADMIN, MEMBER, WORKSPACE, contextFor, freshStore, installStore, resetStore } from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);
after(restore);
beforeEach(() => resetStore(store));

it("picker metadata never reads time history, including budgeted projects", async () => {
  const find = mock.method(TimeEntry, "find", () => { throw Error("history read"); });
  const aggregate = mock.method(TimeEntry, "aggregate", () => { throw Error("history scan"); });
  try {
    for (const person of [OWNER, ADMIN, MEMBER]) {
      const context = contextFor(person);
      const projects = await projectsRouter.createCaller(context).options({ includeArchived: true });
      const clients = await clientsRouter.createCaller(context).options({ includeArchived: true });
      const tasks = await tasksRouter.createCaller(context).options({ includeArchived: true });
      assert.ok(projects.length > 0 && clients.length > 0);
      for (const row of [...projects, ...clients, ...tasks]) {
        assert.equal(row.workspaceId, WORKSPACE);
        assert.equal("totalSec" in row, false);
        assert.equal("entryCount" in row, false);
        assert.equal("progress" in row, false);
      }
      assert.equal(projects[0]?.clientName, "Acme GmbH");
    }
  } finally { find.mock.restore(); aggregate.mock.restore(); }
});

it("metadata respects archive filters and workspace membership", async () => {
  store.projects.rows[0]!.archived = true;
  const api = projectsRouter.createCaller(contextFor(OWNER));
  assert.deepEqual(await api.options({}), []);
  assert.equal((await api.options({ includeArchived: true })).length, 1);
  await assert.rejects(api.options({ workspaceId: "someone-elses-workspace" } as never), { code: "NOT_FOUND" });
});
