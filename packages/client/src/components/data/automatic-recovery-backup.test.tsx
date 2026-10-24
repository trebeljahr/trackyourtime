// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
const state = vi.hoisted(() => ({ version: 0, unlocked: true, listeners: new Set<() => void>(), configure: vi.fn(), choose: vi.fn(), close: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: "workspace", role: "owner" } }) }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => state.unlocked ? {} : null, privateSessionVersion: () => state.version, subscribePrivateSession: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => true }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ client: {} }), privacy: { identity: { useQuery: () => ({ data: { identity: { synthetic: true } } }) } } } }));
vi.mock("@/lib/recovery-backup-folder", () => ({ supportsRecoveryBackupFolders: () => true, chooseRecoveryBackupFolder: () => state.choose() }));
vi.mock("@/lib/recovery-backup-controller", () => ({ recoveryBackupController: async () => ({ close: state.close, read: async () => null, configure: state.configure }) }));
vi.mock("./recovery-backup-driver", () => ({ RECOVERY_BACKUP_CHANGED: "test-backup-settings", noteRecoveryBackupRun: vi.fn(), recoveryBackupRunState: () => "idle", subscribeRecoveryBackupRun: () => () => {} }));
const { AutomaticRecoveryBackup } = await import("./automatic-recovery-backup");
beforeEach(() => { state.version = 0; state.unlocked = true; state.configure.mockReset(); state.close.mockReset(); state.choose.mockReset(); state.choose.mockResolvedValue({ name: "Chosen folder" }); state.configure.mockResolvedValue({ intervalDays: 7, folderName: "Chosen folder", lastBackupAt: null, lastFileName: null }); });
afterEach(cleanup);
it("requires an explicit recovery-key setup and folder choice, then clears the recovery input", async () => {
  render(<AutomaticRecoveryBackup />);
  expect(state.choose).not.toHaveBeenCalled(); expect(state.configure).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Your saved recovery key"), { target: { value: "A".repeat(43) } });
  await waitFor(() => expect(screen.getByTestId("automatic-backup-choose")).toBeEnabled()); fireEvent.click(screen.getByTestId("automatic-backup-choose"));
  await screen.findByTestId("automatic-backup-folder"); expect(state.configure).toHaveBeenCalledWith(expect.objectContaining({ recoveryKey: "A".repeat(43), intervalDays: 7 }));
  expect(screen.queryByLabelText("Your saved recovery key")).not.toBeInTheDocument();
});
it("discards a delayed folder chooser after the private session locks", async () => {
  let finish!: (value: unknown) => void; state.choose.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<AutomaticRecoveryBackup />); fireEvent.change(screen.getByLabelText("Your saved recovery key"), { target: { value: "A".repeat(43) } });
  await waitFor(() => expect(screen.getByTestId("automatic-backup-choose")).toBeEnabled()); fireEvent.click(screen.getByTestId("automatic-backup-choose"));
  act(() => { state.unlocked = false; state.version++; for (const listener of state.listeners) listener(); });
  await screen.findByText(/Set up and unlock private data/); await act(async () => { finish({ name: "Late folder" }); });
  expect(state.configure).not.toHaveBeenCalled(); expect(screen.queryByTestId("automatic-backup-folder")).not.toBeInTheDocument();
});
