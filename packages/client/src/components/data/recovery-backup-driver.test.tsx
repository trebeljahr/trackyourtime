// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
const state = vi.hoisted(() => ({ role: "member", unlocked: true, mode: vi.fn(), privateRun: vi.fn(), standardRun: vi.fn(), source: vi.fn(), privateClose: vi.fn(), standardClose: vi.fn(), utils: { client: {} } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "user" } }) }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: "workspace", role: state.role } }) }));
vi.mock("@/lib/private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => state.unlocked ? {} : null, privateSessionVersion: () => 1, subscribePrivateSession: () => () => {} }));
vi.mock("@/lib/server-level", () => ({ useServerSupports: () => true }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => state.utils } }));
vi.mock("@/lib/private-recovery-mode", () => ({ privateRecoveryMode: state.mode }));
vi.mock("@/lib/recovery-backup-folder", () => ({ supportsRecoveryBackupFolders: () => true }));
vi.mock("@/lib/private-recovery-controller", () => ({ privateRecoveryController: async () => ({ run: state.privateRun, close: state.privateClose }) }));
vi.mock("@/lib/recovery-backup-controller", () => ({ recoveryBackupController: async () => ({ run: state.standardRun, close: state.standardClose }) }));
vi.mock("@/lib/combined-backup-source", () => ({ readCombinedBackupSource: state.source }));
const { RecoveryBackupDriver } = await import("./recovery-backup-driver");
beforeEach(() => { state.role = "member"; state.unlocked = true; for (const fn of [state.mode, state.privateRun, state.standardRun, state.source, state.privateClose, state.standardClose]) fn.mockReset(); state.mode.mockResolvedValue("encrypted"); state.privateRun.mockResolvedValue({ status: "off" }); state.standardRun.mockResolvedValue({ status: "off" }); });
afterEach(cleanup);
it("runs private member backups without invoking any standard owner source", async () => {
  const view = render(<RecoveryBackupDriver />); await waitFor(() => expect(state.privateRun).toHaveBeenCalledOnce());
  expect(state.standardRun).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled(); view.unmount(); expect(state.privateClose).toHaveBeenCalledOnce();
});
it("keeps standard owner schedules for unenrolled accounts", async () => {
  state.role = "owner"; state.mode.mockResolvedValue("unenrolled"); render(<RecoveryBackupDriver />);
  await waitFor(() => expect(state.standardRun).toHaveBeenCalledOnce()); expect(state.privateRun).not.toHaveBeenCalled();
});
it("never falls back to plaintext after a corrupt inventory or missing workspace", async () => {
  state.role = "owner"; state.mode.mockRejectedValue(new Error("Untrusted local inventory")); render(<RecoveryBackupDriver />);
  await waitFor(() => expect(state.mode).toHaveBeenCalledOnce()); expect(state.standardRun).not.toHaveBeenCalled(); expect(state.privateRun).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
});
it("does not start locked schedules or a delayed mode lookup after the component closes", async () => {
  state.unlocked = false; const locked = render(<RecoveryBackupDriver />); expect(state.mode).not.toHaveBeenCalled(); locked.unmount();
  state.unlocked = true; let resume!: (value: string) => void; state.mode.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
  const view = render(<RecoveryBackupDriver />); await waitFor(() => expect(state.mode).toHaveBeenCalledOnce()); view.unmount(); resume("encrypted");
  await new Promise((resolve) => setTimeout(resolve, 0)); expect(state.privateRun).not.toHaveBeenCalled(); expect(state.standardRun).not.toHaveBeenCalled();
});
