import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data?: unknown; error?: { error?: string; error_description?: string } | null };

const device = vi.fn<(args: { query: { user_code: string } }) => Promise<Result>>();
const approve = vi.fn<(args: { userCode: string }) => Promise<Result>>();
const deny = vi.fn<(args: { userCode: string }) => Promise<Result>>();

// `authClient.device` is both callable and carries approve/deny.
vi.mock("@/lib/auth-client", () => {
  const deviceFn = Object.assign(
    (args: { query: { user_code: string } }) => device(args),
    {
      approve: (args: { userCode: string }) => approve(args),
      deny: (args: { userCode: string }) => deny(args),
    },
  );
  return { authClient: { device: deviceFn } };
});

const { approveDeviceCode, decideDeviceCode, denyDeviceCode } = await import("./device-approve");

const ALREADY = { error: "invalid_request", error_description: "Device code already processed" };

beforeEach(() => {
  device.mockReset();
  approve.mockReset();
  deny.mockReset();
  device.mockResolvedValue({ data: { user_code: "ABCD1234", status: "pending" }, error: null });
  approve.mockResolvedValue({ data: { success: true }, error: null });
  deny.mockResolvedValue({ data: { success: true }, error: null });
});

describe("decideDeviceCode", () => {
  it("claims before approving", async () => {
    await expect(approveDeviceCode("ABCD1234")).resolves.toEqual({ ok: true });
    expect(device).toHaveBeenCalledWith({ query: { user_code: "ABCD1234" } });
    expect(approve).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(device.mock.invocationCallOrder[0]).toBeLessThan(approve.mock.invocationCallOrder[0]!);
  });

  it("denies after claiming", async () => {
    await expect(denyDeviceCode("ABCD1234")).resolves.toEqual({ ok: true });
    expect(deny).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("reports a refused claim without approving", async () => {
    device.mockResolvedValue({ error: { error: "invalid_request", error_description: "Invalid user code" } });
    await expect(approveDeviceCode("ABCD1234")).resolves.toEqual({
      ok: false,
      stage: "claim",
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });
    expect(approve).not.toHaveBeenCalled();
  });

  it("reports a refused approve", async () => {
    approve.mockResolvedValue({ error: { error: "expired_token" } });
    await expect(approveDeviceCode("ABCD1234")).resolves.toEqual({
      ok: false,
      stage: "decide",
      error: { error: "expired_token" },
    });
  });

  it("reports a thrown request as a network failure", async () => {
    device.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(approveDeviceCode("ABCD1234")).resolves.toEqual({ ok: false, stage: "network" });
  });

  it("keeps reporting an already processed code to the device page", async () => {
    approve.mockResolvedValue({ error: ALREADY });
    await expect(decideDeviceCode("ABCD1234", "approve")).resolves.toMatchObject({
      ok: false,
      stage: "decide",
    });
  });

  describe("alreadyApprovedIsOk (the bridge)", () => {
    it("skips the approve when the claim says another tab already approved", async () => {
      device.mockResolvedValue({ data: { status: "approved" }, error: null });
      await expect(approveDeviceCode("ABCD1234", { alreadyApprovedIsOk: true })).resolves.toEqual({
        ok: true,
      });
      expect(approve).not.toHaveBeenCalled();
    });

    it("asks again after losing the race, and accepts an approved code", async () => {
      device
        .mockResolvedValueOnce({ data: { status: "pending" }, error: null })
        .mockResolvedValueOnce({ data: { status: "approved" }, error: null });
      approve.mockResolvedValue({ error: ALREADY });
      await expect(approveDeviceCode("ABCD1234", { alreadyApprovedIsOk: true })).resolves.toEqual({
        ok: true,
      });
      expect(device).toHaveBeenCalledTimes(2);
    });

    it("does not mistake a denied code for an approved one", async () => {
      device
        .mockResolvedValueOnce({ data: { status: "pending" }, error: null })
        .mockResolvedValueOnce({ data: { status: "denied" }, error: null });
      approve.mockResolvedValue({ error: ALREADY });
      await expect(approveDeviceCode("ABCD1234", { alreadyApprovedIsOk: true })).resolves.toMatchObject({
        ok: false,
        stage: "decide",
      });
    });

    it("never treats a claimed-denied code as success", async () => {
      device.mockResolvedValue({ data: { status: "denied" }, error: null });
      approve.mockResolvedValue({ error: ALREADY });
      await expect(approveDeviceCode("ABCD1234", { alreadyApprovedIsOk: true })).resolves.toMatchObject({
        ok: false,
      });
    });
  });
});
