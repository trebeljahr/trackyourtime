// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { encryptPrivateWorkspaceBackup, encryptBackup, encryptCombinedRecoveryKeyBackup, emptyRecoverySupplementCollections, recoverySupplementDigest, deriveRecoveryBackupKey, emptyRecoveryCollections, encodeSecret, encryptRecoveryKeyBackup, randomSecret, recoveryDigest } from "@starter/core";
const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/download", () => ({ downloadBlob: download }));
const { OpenRecoveryBackup } = await import("./open-recovery-backup");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob); download.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function fixture() {
  const secret = encodeSecret(randomSecret()), collections = emptyRecoveryCollections();
  collections.invoices.push({ _id: { $oid: "0123456789abcdef01234567" }, workspaceId: "workspace", xml: "<Invoice>Offline original</Invoice>" });
  const archive = { format: "trackyourtime-workspace-recovery-v1" as const, server: "https://api.example.test", ownerId: "owner", snapshot: { v: 1 as const, workspaceId: "workspace", createdAt: "2026-10-24T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections } };
  const key = await deriveRecoveryBackupKey(secret, { server: archive.server, userId: archive.ownerId });
  const text = JSON.stringify(await encryptRecoveryKeyBackup(archive, key, () => true)); key.fill(0);
  return { secret, archive, text };
}
it("opens a recovery-key file locally without login or fetch and saves plaintext only on a separate request", async () => {
  const f = await fixture(), fetcher = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", fetcher);
  render(<OpenRecoveryBackup />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: f.text.length, text: async () => f.text }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: f.secret } });
  fireEvent.click(screen.getByText("Open local backup"));
  await screen.findByText(/Backup verified/); expect(download).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Backup password or recovery key")).toHaveValue("");
  fireEvent.click(screen.getByText("Save decrypted recovery JSON"));
  expect(JSON.parse(await (download.mock.calls[0]![1] as NodeBlob).text())).toEqual(f.archive);
});
it("rejects a wrong recovery key and never releases a decrypted download", async () => {
  const f = await fixture(); render(<OpenRecoveryBackup />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: f.text.length, text: async () => f.text }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: encodeSecret(randomSecret()) } });
  fireEvent.click(screen.getByText("Open local backup")); expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this backup");
  expect(download).not.toHaveBeenCalled(); expect(screen.queryByText("Save decrypted recovery JSON")).not.toBeInTheDocument();
});
it("discards a late file read after leaving the recovery screen", async () => {
  const f = await fixture(); let finish!: (value: string) => void;
  const { unmount } = render(<OpenRecoveryBackup />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: f.text.length, text: () => new Promise<string>((resolve) => { finish = resolve; }) }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: f.secret } }); fireEvent.click(screen.getByText("Open local backup")); unmount(); finish(f.text);
  await waitFor(() => expect(download).not.toHaveBeenCalled());
});


it("opens older password-protected exports without account access", async () => {
  const password = "a separate saved backup password", value = { entries: [{ description: "Original portable work" }], invoices: [] };
  const text = JSON.stringify(await encryptBackup(value, password));
  render(<OpenRecoveryBackup />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: text.length, text: async () => text }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: password } }); fireEvent.click(screen.getByText("Open local backup"));
  await screen.findByText(/Save its decrypted JSON to inspect/); fireEvent.click(screen.getByText("Save decrypted JSON"));
  expect(download.mock.calls[0]![0]).toBe("trackyourtime-restored-export.json");
  expect(JSON.parse(await (download.mock.calls[0]![1] as NodeBlob).text())).toEqual(value);
});

it("opens a combined file without network, warns about plaintext secrets and exports both verified datasets only on request", async () => {
  const f = await fixture(), collections = emptyRecoverySupplementCollections();
  collections.organization.push({ _id: "workspace", name: "Original studio" });
  collections.webhooksubscriptions.push({ _id: "hook", workspaceId: "workspace", createdBy: "owner", secret: "Original integration secret" });
  const archive = { ...f.archive, format: "trackyourtime-workspace-recovery-v2" as const, supplement: { v: 1 as const, workspaceId: "workspace", createdAt: f.archive.snapshot.createdAt, sourceRevision: await recoverySupplementDigest(collections), collections } };
  const key = await deriveRecoveryBackupKey(f.secret, { server: archive.server, userId: archive.ownerId });
  const text = JSON.stringify(await encryptCombinedRecoveryKeyBackup(archive, key, () => true)); key.fill(0);
  const fetcher = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", fetcher);
  render(<OpenRecoveryBackup standalone />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: text.length, text: async () => text }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: f.secret } }); fireEvent.click(screen.getByText("Open local backup"));
  expect(await screen.findByRole("status")).toHaveTextContent("Saving JSON creates an unencrypted copy");
  expect(fetcher).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save decrypted recovery JSON"));
  expect(download.mock.calls[0]![0]).toBe("trackyourtime-combined-recovery.json");
  expect(JSON.parse(await (download.mock.calls[0]![1] as NodeBlob).text())).toEqual(archive);
});

it("opens private history and exact unsent work offline without exporting root keys or changing live data", async () => {
  const { privateRecoveryFixture } = await import("@/test-private-recovery"), f = await privateRecoveryFixture();
  const text = JSON.stringify(await encryptPrivateWorkspaceBackup(f.archive, f.key, f.secrets, f.current));
  const fetcher = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", fetcher);
  render(<OpenRecoveryBackup standalone />);
  fireEvent.change(screen.getByLabelText("Encrypted recovery file"), { target: { files: [{ size: text.length, text: async () => text }] } });
  fireEvent.change(screen.getByLabelText("Backup password or recovery key"), { target: { value: f.recoveryKey } }); fireEvent.click(screen.getByText("Open local backup"));
  expect(await screen.findByRole("status")).toHaveTextContent("this device’s unsent edits"); expect(download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save decrypted recovery JSON"));
  expect(download.mock.calls[0]![0]).toBe("trackyourtime-private-workspace-export.json");
  const raw = await (download.mock.calls[0]![1] as NodeBlob).text(), value = JSON.parse(raw);
  expect(value.confirmedRecords).toHaveLength(2); expect(value.records.find((row: { id: string }) => row.id === "tag").value.name).toBe("Unsent private rename");
  expect(value.pending).toEqual(f.archive.replica.pending); expect(value.identity).toBeUndefined(); expect(value.inventory).toBeUndefined();
  for (const secret of [f.secrets.master, f.secrets.privateKey.d!, f.secrets.signingPrivateKey.d!, f.recoveryKey]) expect(raw).not.toContain(secret);
  expect(await f.replica.exportRecovery()).toEqual(f.archive.replica); expect(fetcher).not.toHaveBeenCalled();
});
