// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { decryptBackup, emptyRecoveryCollections, recoveryDigest } from "@starter/core";
const state = vi.hoisted(() => ({ workspace: { id: "a", role: "member" }, exportJson: vi.fn(), recoverySnapshot: vi.fn(), download: vi.fn() }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: state.workspace }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test" }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => true }));
vi.mock("@/lib/trpc", () => ({ trpc: { data: { exportJson: { useMutation: () => ({ mutateAsync: state.exportJson }) } }, privacy: { recoverySnapshot: { useMutation: () => ({ mutateAsync: state.recoverySnapshot }) } } } }));
vi.mock("@/lib/download", () => ({ downloadBlob: state.download }));
const { EncryptedBackup } = await import("./encrypted-backup");
const password = "synthetic-password-only";
const fixture = { entries: [{ description: "Confidential meeting", durationSec: 3600 }], invoices: [] };
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NodeBlob); state.workspace = { id: "a", role: "member" }; state.exportJson.mockReset(); state.recoverySnapshot.mockReset(); state.download.mockReset(); localStorage.clear(); state.exportJson.mockResolvedValue(fixture); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const fill = () => {
  fireEvent.change(screen.getByLabelText("Backup password (at least 12 characters)"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm backup password"), { target: { value: password } });
};
describe("encrypted workspace export", () => {
  it("downloads authenticated ciphertext, preserves exported content and clears the password", async () => {
    render(<EncryptedBackup />); fill(); fireEvent.click(screen.getByTestId("encrypted-backup-download"));
    await waitFor(() => expect(state.download).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(state.exportJson).toHaveBeenCalledWith({ workspaceId: "a" });
    const text = await (state.download.mock.calls[0]![1] as NodeBlob).text();
    expect(text).not.toContain("Confidential meeting"); expect(text).not.toContain(password);
    expect(await decryptBackup(JSON.parse(text), password)).toEqual(fixture);
    expect((screen.getByLabelText("Backup password (at least 12 characters)") as HTMLInputElement).value).toBe("");
  });
  it("does not download another workspace's in-flight export after a switch", async () => {
    let finish!: (value: unknown) => void;
    state.exportJson.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<EncryptedBackup />); fill(); fireEvent.click(screen.getByTestId("encrypted-backup-download"));
    state.workspace = { id: "b", role: "member" }; rerender(<EncryptedBackup />); finish(fixture);
    await waitFor(() => expect(screen.queryByText("Preparing…")).toBeNull());
    expect(state.download).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Backup password (at least 12 characters)") as HTMLInputElement).value).toBe("");
  });
  it("saves an owner-only lossless backup, verifies it locally and keeps it out of the ordinary importer", async () => {
    const collections = emptyRecoveryCollections();
    collections.invoices.push({ _id: { $oid: "00112233445566778899aabb" }, workspaceId: "a", xml: "<Invoice>Original issued XML</Invoice>", entryIds: ["original-entry"] });
    const snapshot = { v: 1, workspaceId: "a", createdAt: "2026-10-23T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections };
    state.recoverySnapshot.mockResolvedValue(snapshot); state.workspace.role = "owner";
    render(<EncryptedBackup />); fill(); fireEvent.click(screen.getByTestId("encrypted-recovery-download"));
    await waitFor(() => expect(state.download).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(state.recoverySnapshot).toHaveBeenCalledWith({ workspaceId: "a" }); expect(state.exportJson).not.toHaveBeenCalled();
    const text = await (state.download.mock.calls[0]![1] as NodeBlob).text();
    expect(text).not.toContain("Original issued XML");
    expect(await decryptBackup(JSON.parse(text), password)).toMatchObject({ format: "trackyourtime-workspace-recovery-v1", server: "https://api.example.test", ownerId: "owner", snapshot });
    fill(); fireEvent.change(screen.getByLabelText("Open an encrypted backup"), { target: { files: [{ size: text.length, text: async () => text }] } });
    await waitFor(() => expect(screen.getByText(/Recovery file verified/)).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(screen.getByText("Save decrypted recovery JSON"));
    expect(state.download.mock.calls[1]![0]).toBe("trackyourtime-workspace-recovery.json");
    expect(JSON.parse(await (state.download.mock.calls[1]![1] as NodeBlob).text())).toMatchObject({ snapshot });
    expect(state.recoverySnapshot).toHaveBeenCalledTimes(1);
  });
});
