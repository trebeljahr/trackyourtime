// Who may read and change the business profile: role × money-visibility.
//
// The profile carries payment details and is printed on every invoice, so it
// is read like money (owner/admin, or a member with `canViewOthersMoney`) and
// changed only by an owner or admin. Driven through the real router caller
// with the two model handles stubbed, like invoice-workspace-scope.test.ts,
// so no database is needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import { BUSINESS_LOGO_REFUSALS, type WorkspaceRole } from "@starter/shared";
import {
  BusinessProfileInvalidError,
  BusinessProfileModel,
  saveBusinessProfile,
} from "../models/BusinessProfile.js";
import {
  WorkspaceMember,
  type WorkspaceMemberDocLike,
} from "../models/WorkspaceMember.js";
import { settingsRouter } from "../trpc/routers/settings.js";
import type { Context } from "../trpc/context.js";

mongoose.set("bufferCommands", false);

const USER = "user_bob";
const WORKSPACE = "ws_team";
const LOGO_PNG = readFileSync(fileURLToPath(new URL("./fixtures/logo/rgba.png", import.meta.url)));

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
  const { $set, $unset } = update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
  // A profile save `$set`s the whole merged row; the logo procedures `$set`
  // or `$unset` the one key. Merging over the last row covers both.
  stored = { ...(stored ?? {}), ...($set ?? {}), updatedAt: new Date("2026-09-14T08:00:00.000Z") };
  for (const key of Object.keys($unset ?? {})) delete stored[key];
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

    it(`${label}: logo upload and removal ${row.write ? "allowed" : "refused"}`, async () => {
      writes = 0;
      stored = null;
      const caller = as(row.role, row.money);
      const set = caller.setBusinessLogo({ mime: "image/png", base64: LOGO_PNG.toString("base64") });
      if (!row.write) {
        await forbidden(set);
        await forbidden(caller.clearBusinessLogo({}));
        assert.equal(writes, 0, "a refused logo change still wrote");
        return;
      }
      const withLogo = await set;
      assert.equal(writes, 1);
      assert.deepEqual([withLogo.logo?.width, withLogo.logo?.height], [48, 16]);
      assert.equal(withLogo.logo?.dataUrl, `data:image/png;base64,${LOGO_PNG.toString("base64")}`);
      const cleared = await caller.clearBusinessLogo({});
      assert.equal(writes, 2);
      assert.equal(cleared.logo, null);
    });
  }

  it("refuses bytes that are not a logo before any write, as BAD_REQUEST with the code", async () => {
    writes = 0;
    stored = null;
    await assert.rejects(
      as("owner", true).setBusinessLogo({ mime: "image/png", base64: Buffer.from("<svg/>").toString("base64") }),
      (error: unknown) =>
        error instanceof TRPCError &&
        error.code === "BAD_REQUEST" &&
        error.message === BUSINESS_LOGO_REFUSALS.unsupportedFormat,
    );
    assert.equal(writes, 0);
  });
});

describe("saving the business profile merges over the stored row", () => {
  it("keeps a field the update leaves out, and clears one sent as null", async () => {
    stored = null;
    writes = 0;
    await saveBusinessProfile(WORKSPACE, {
      legalName: "Example GmbH",
      iban: "DE02120300000000202051",
      vatId: "DE123456789",
    });
    // A form or an export file written before the e-invoice fields existed.
    const profile = await saveBusinessProfile(WORKSPACE, { legalName: "Example AG", vatId: null });
    assert.equal(writes, 2);
    assert.equal(profile.legalName, "Example AG");
    assert.equal(profile.iban, "DE02120300000000202051");
    assert.equal(profile.vatId, null);
    assert.equal(profile.smallBusiness, false);
  });

  it("checks cross-field rules on the merged row and writes nothing when one fails", async () => {
    stored = null;
    await saveBusinessProfile(WORKSPACE, { defaultTaxCategory: "S", defaultTaxRate: 19 });
    writes = 0;
    await assert.rejects(
      saveBusinessProfile(WORKSPACE, { defaultTaxRate: null }),
      (error: unknown) => error instanceof BusinessProfileInvalidError && error.path === "defaultTaxRate",
    );
    await assert.rejects(
      saveBusinessProfile(WORKSPACE, { electronicAddress: "invoices@example.com" }),
      (error: unknown) => error instanceof BusinessProfileInvalidError && error.path === "electronicAddressScheme",
    );
    assert.equal(writes, 0);
  });
});
