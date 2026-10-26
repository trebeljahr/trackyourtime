import assert from "node:assert/strict";
import { after, it } from "node:test";
import { normalizeDisplayPreferences } from "@starter/shared";
import { UserPreferencesModel, WorkspaceSettingsModel } from "../models/Settings.js";
import { profileRouter } from "../trpc/routers/profile.js";
import type { Context } from "../trpc/context.js";
const real = { find: UserPreferencesModel.findOne, update: UserPreferencesModel.updateOne, workspace: WorkspaceSettingsModel.findOne };
let source: unknown = null, seen: unknown, selected = "", writes = 0, workspaceReads = 0;
UserPreferencesModel.findOne = ((filter: unknown) => { seen = filter; return { select: (fields: string) => { selected = fields; return { lean: async () => source }; } }; }) as unknown as typeof UserPreferencesModel.findOne;
UserPreferencesModel.updateOne = (() => { writes++; throw new Error("Must not create preferences"); }) as unknown as typeof UserPreferencesModel.updateOne;
WorkspaceSettingsModel.findOne = (() => { workspaceReads++; throw new Error("Must not read workspace settings"); }) as unknown as typeof WorkspaceSettingsModel.findOne;
after(() => { UserPreferencesModel.findOne = real.find; UserPreferencesModel.updateOne = real.update; WorkspaceSettingsModel.findOne = real.workspace; });
const context = { user: { id: "person" }, session: { id: "session" }, client: { kind: "web", version: null, apiLevel: null } } as unknown as Context;
it("returns only the authenticated person's display preferences and never reads or creates workspace data", async () => {
 source = { timeFormat: "12h", theme: "dark", defaultHourlyRate: 999, currency: "USD", workspaceId: "private" };
 const result = await profileRouter.createCaller(context).displayPreferences();
 assert.deepEqual(seen, { userId: "person" }); assert.equal(selected, "timeFormat durationFormat theme locale idle maxDuration"); assert.equal(result.timeFormat, "12h"); assert.equal(result.theme, "dark"); assert.equal("defaultHourlyRate" in result, false); assert.equal("workspaceId" in result, false); assert.equal(writes, 0); assert.equal(workspaceReads, 0);
});
it("returns legacy account defaults for a missing row without writing one and refuses an unauthenticated caller", async () => {
 source = null; assert.deepEqual(await profileRouter.createCaller(context).displayPreferences(), normalizeDisplayPreferences("person")); assert.equal(writes, 0);
 await assert.rejects(profileRouter.createCaller({ ...context, user: null } as unknown as Context).displayPreferences());
});
