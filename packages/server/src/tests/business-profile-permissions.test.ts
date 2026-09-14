// Who may read and change the business profile: role × money-visibility.
//
// The profile carries payment details and is printed on every invoice, so it
// is read like money (owner/admin, or a member with `canViewOthersMoney`) and
// changed only by an owner or admin. Driven through the real router caller
// with the two model handles stubbed, like invoice-workspace-scope.test.ts,
// so no database is needed.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import type { WorkspaceRole } from "@starter/shared";
import { BusinessProfileModel } from "../models/BusinessProfile.js";
import {
  WorkspaceMember,
  type WorkspaceMemberDocLike,
} from "../models/WorkspaceMember.js";
import { settingsRouter } from "../trpc/routers/settings.js";
import type { Context } from "../trpc/context.js";

mongoose.set("bufferCommands", false);

const USER = "user_bob";
const WORKSPACE = "ws_team";

type LeanQuery<T> = { lean: () => Promise<T> };

const memberHandle = WorkspaceMember as unknown as {
  findOne: (filter: Record<string, unknown>) => LeanQuery<WorkspaceMemberDocLike | null>;
};
const profileHandle = BusinessProfileModel as unknown as {
  findOne: (filter: Record<string, unknown>) => LeanQuery<Record<string, unknown> | null>;
  updateOne: (...args: unknown[]) => Promise<unknown>;
};
const real = {
  memberFindOne: memberHandle.findOne,
  profileFindOne: profileHandle.findOne,
  profileUpdateOne: profileHandle.updateOne,
};

let current: WorkspaceMemberDocLike;
let stored: Record<string, unknown> | null = null;
let writes = 0;

memberHandle.findOne = () => ({ lean: async () => current });
profileHandle.findOne = () => ({ lean: async () => stored });
profileHandle.updateOne = async (_filter, update) => {
  writes += 1;
  const set = (update as { $set: Record<string, unknown> }).$set;
  stored = { ...set, updatedAt: new Date("2026-09-14T08:00:00.000Z") };
  return { acknowledged: true };
};

after(() => {
  memberHandle.findOne = real.memberFindOne;
  profileHandle.findOne = real.profileFindOne;
  profileHandle.updateOne = real.profileUpdateOne;
});

const as = (role: WorkspaceRole, canViewOthersMoney: boolean) => {
  current = {
    workspaceId: WORKSPACE,
    userId: USER,
    role,
    name: "Bob",
    hourlyRate: null,
    canViewOthersTime: true,
    canViewOthersMoney,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  return settingsRouter.createCaller({
    req: undefined,
    res: undefined,
    session: { session: { activeOrganizationId: WORKSPACE }, user: { id: USER } },
    user: { id: USER },
    authMethod: "cookie",
    activeWorkspaceId: WORKSPACE,
  } as unknown as Context);
};

const forbidden = async (promise: Promise<unknown>): Promise<void> => {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof TRPCError && error.code === "FORBIDDEN",
  );
};

const MATRIX: { role: WorkspaceRole; money: boolean; read: boolean; write: boolean }[] = [
  { role: "owner", money: true, read: true, write: true },
  { role: "owner", money: false, read: true, write: true },
  { role: "admin", money: true, read: true, write: true },
  { role: "admin", money: false, read: true, write: true },
  { role: "member", money: true, read: true, write: false },
  { role: "member", money: false, read: false, write: false },
];

describe("business profile permissions", () => {
  for (const row of MATRIX) {
    const label = `${row.role}${row.money ? " with" : " without"} canViewOthersMoney`;

    it(`${label}: read ${row.read ? "allowed" : "refused"}`, async () => {
      stored = null;
      const call = as(row.role, row.money).businessProfile();
      if (!row.read) return forbidden(call);
      const profile = await call;
      assert.equal(profile.workspaceId, WORKSPACE);
      assert.equal(profile.updatedAt, null);
    });

    it(`${label}: update ${row.write ? "allowed" : "refused"}`, async () => {
      writes = 0;
      stored = null;
      const call = as(row.role, row.money).updateBusinessProfile({
        legalName: "  Team Ltd ",
        taxId: "",
        country: "gb",
      });
      if (!row.write) {
        await forbidden(call);
        assert.equal(writes, 0, "a refused update still wrote");
        return;
      }
      const profile = await call;
      assert.equal(writes, 1);
      assert.equal(profile.legalName, "Team Ltd");
      assert.equal(profile.taxId, null);
      assert.equal(profile.country, "GB");
    });
  }
});
