// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
const state = vi.hoisted(() => ({ mode: "encrypted", settings: null as unknown, folders: false, identity: true, configure: vi.fn(), download: vi.fn(), save: vi.fn(), choose: vi.fn(), close: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: "workspace", role: "member" } }) }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => ({}), privateSessionVersion: () => 1, subscribePrivateSession: () => () => {} }));
vi.mock("@/lib/private-recovery-mode", () => ({ privateRecoveryMode: async () => { if (state.mode === "error") throw new Error("Corrupted inventory"); return state.mode; } }));
vi.mock("@/lib/trpc", () => ({ trpc: { privacy: { identity: { useQuery: () => ({ data: state.identity ? { identity: { synthetic: true } } : null }) } } } }));
vi.mock("@/lib/recovery-backup-folder", () => ({ supportsRecoveryBackupFolders: () => state.folders, chooseRecoveryBackupFolder: () => state.choose() }));
vi.mock("@/lib/private-recovery-controller", () => ({ privateRecoveryController: async () => ({ close: state.close, read: async () => state.settings, configure: state.configure, download: state.download }) }));
vi.mock("@/lib/download", () => ({ downloadBlob: state.save }));
vi.mock("./automatic-recovery-backup", () => ({ AutomaticRecoveryBackup: () => <p>Standard backup controls</p> }));
const { PrivateWorkspaceBackup, WorkspaceRecoveryBackup } = await import("./private-workspace-backup");
beforeEach(() => {
  state.mode = "encrypted"; state.folders = false; state.identity = true; state.settings = null;
  state.configure.mockReset(); state.download.mockReset(); state.save.mockReset(); state.choose.mockReset(); state.close.mockReset();
  state.configure.mockResolvedValue({ intervalDays: 7, folderName: null, lastBackupAt: null, lastFileName: null });
  state.download.mockResolvedValue({ header: { createdAt: "2026-10-26T00:00:00.000Z", fileId: "00000000-0000-4000-8000-000000000000" }, parts: ["synthetic ciphertext"] });
});
afterEach(cleanup);
it("offers private backups for a trusted member and never mounts the standard controls", async () => {
  render(<WorkspaceRecoveryBackup />); await screen.findByTestId("private-workspace-backup");
  expect(screen.queryByText("Standard backup controls")).not.toBeInTheDocument(); expect(state.choose).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
});
it("keeps standard controls for existing unenrolled users and fails closed on corrupt local inventory", async () => {
  state.mode = "unenrolled"; const view = render(<WorkspaceRecoveryBackup />); await screen.findByText("Standard backup controls"); view.unmount();
  state.mode = "error"; render(<WorkspaceRecoveryBackup />); await screen.findByRole("alert"); expect(screen.queryByText("Standard backup controls")).not.toBeInTheDocument();
});
it("verifies a recovery key only on request and downloads ciphertext without folder support", async () => {
  render(<PrivateWorkspaceBackup userId="owner" workspaceId="workspace" />);
  fireEvent.change(screen.getByLabelText("Your saved recovery key"), { target: { value: "A".repeat(43) } });
  const button = screen.getByText("Save encrypted private workspace backup"); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(state.configure).toHaveBeenCalledWith(expect.objectContaining({ recoveryKey: "A".repeat(43), identity: { synthetic: true } })); expect(state.choose).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Your saved recovery key")).not.toBeInTheDocument();
});
it("uses the existing encrypted cache offline without asking for the server recovery identity", async () => {
  state.identity = false; state.settings = { intervalDays: 1, folderName: null, lastBackupAt: null, lastFileName: null };
  render(<PrivateWorkspaceBackup userId="owner" workspaceId="workspace" />); const button = screen.getByText("Save encrypted private workspace backup");
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); await waitFor(() => expect(state.save).toHaveBeenCalledOnce()); expect(state.configure).not.toHaveBeenCalled();
});
it("does not download or accept a late folder choice after leaving the screen", async () => {
  state.folders = true; let resume!: (value: unknown) => void; state.choose.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
  const view = render(<PrivateWorkspaceBackup userId="owner" workspaceId="workspace" />);
  fireEvent.change(screen.getByLabelText("Your saved recovery key"), { target: { value: "A".repeat(43) } });
  const button = screen.getByText("Choose backup folder"); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); view.unmount(); resume({ name: "Late folder" });
  await waitFor(() => expect(state.close).toHaveBeenCalledOnce()); expect(state.configure).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
});
