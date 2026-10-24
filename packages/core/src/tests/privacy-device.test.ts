import assert from "node:assert/strict";
import { it } from "node:test";
import { createPrivateDeviceReceiver, encryptPrivateDeviceApproval, privateDeviceInviteFromHash, privateDeviceUrl } from "../privacy/device.js";
import { PRIVATE_DEVICE_TTL_MS } from "@starter/shared";
const scope = { server: "https://api.example.test", userId: "owner" };
it("transfers an identity only to the requesting device, after the browser's confirmation code", async () => {
  const receiver = await createPrivateDeviceReceiver<{ master: string }>(scope);
  const url = privateDeviceUrl("https://app.example.test", receiver.invite);
  assert.deepEqual(privateDeviceInviteFromHash(new URL(url).hash), receiver.invite);
  assert.ok(!url.includes("master"));
  const value = { master: "synthetic-private-account-key" };
  const { approval, code } = await encryptPrivateDeviceApproval(receiver.invite, value);
  assert.doesNotMatch(JSON.stringify(approval), /synthetic-private-account-key/);
  assert.ok(!JSON.stringify(approval).includes(code));
  await receiver.accept(approval);
  await assert.rejects(receiver.accept(approval), /already/);
  assert.deepEqual(receiver.confirm(`${code.slice(0, 4)} ${code.slice(4)}`.toLowerCase()), value);
  assert.throws(() => receiver.confirm(code), /closed/);
});
it("rejects another device, tampering, a changed account binding and relay replacement", async () => {
  const receiver = await createPrivateDeviceReceiver(scope), other = await createPrivateDeviceReceiver(scope);
  const real = await encryptPrivateDeviceApproval(receiver.invite, { master: "real" });
  await assert.rejects(other.accept(real.approval));
  const rebound = await encryptPrivateDeviceApproval({ ...receiver.invite, userId: "other" }, { master: "wrong-account" });
  await assert.rejects(receiver.accept(rebound.approval));
  const fresh = await createPrivateDeviceReceiver(scope);
  const original = await encryptPrivateDeviceApproval(fresh.invite, { master: "real" });
  let replacement = await encryptPrivateDeviceApproval(fresh.invite, { master: "attacker" });
  while (replacement.code === original.code) replacement = await encryptPrivateDeviceApproval(fresh.invite, { master: "attacker" });
  await fresh.accept(replacement.approval);
  assert.throws(() => fresh.confirm(original.code), /did not match/);
  // A request with a bad candidate cannot be retried with a different packet.
  await assert.rejects(fresh.accept(original.approval), /already/);
  fresh.cancel();
});
it("expires, cancels, and closes after three failed code attempts without releasing the value", async () => {
  let time = 1_800_000_000_000;
  const receiver = await createPrivateDeviceReceiver(scope, () => time);
  const response = await encryptPrivateDeviceApproval(receiver.invite, { master: "private" }, () => time);
  await receiver.accept(response.approval); time += PRIVATE_DEVICE_TTL_MS;
  assert.throws(() => receiver.confirm(response.code), /expired/);
  const cancelled = await createPrivateDeviceReceiver(scope); cancelled.cancel();
  await assert.rejects(cancelled.accept(response.approval), /closed/);
  const wrong = await createPrivateDeviceReceiver(scope), candidate = await encryptPrivateDeviceApproval(wrong.invite, { master: "private" });
  await wrong.accept(candidate.approval);
  for (let i = 0; i < 3; i++) assert.throws(() => wrong.confirm("invalid"), /did not match/);
  assert.throws(() => wrong.confirm(candidate.code), /closed/);
});
