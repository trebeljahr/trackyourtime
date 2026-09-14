// @vitest-environment jsdom
/**
 * Inviting. Three things matter: an admin can never pick "admin"; a server
 * with no email set up still hands the inviter a link they can send; and a
 * refusal reads as a sentence, not as the server's identifier.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InvitableRole, InviteResult } from "@starter/shared";

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { InviteForm } = await import("./invite-form");
const { membershipErrorMessage } = await import("./membership-errors");

afterEach(cleanup);

const result = (emailSent: boolean): InviteResult => ({
  emailSent,
  invitation: {
    id: "inv-1",
    email: "bob@example.com",
    role: "member",
    inviterName: "Olivia",
    expiresAt: "2026-09-21T10:00:00.000Z",
    inviteUrl: "https://trackyourtime.dev/invite/?id=inv-1",
  },
});

type OnInvite = (input: { email: string; role: InvitableRole }) => Promise<InviteResult>;

const fill = (email: string): void => {
  fireEvent.change(screen.getByTestId("invite-email"), { target: { value: email } });
};

describe("InviteForm", () => {
  it("offers the admin role to owners only", () => {
    const onInvite = vi.fn<OnInvite>();
    const { rerender } = render(<InviteForm canInviteAdmins onInvite={onInvite} />);
    expect(screen.queryByTestId("invite-role-admin")).toBeInTheDocument();

    rerender(<InviteForm canInviteAdmins={false} onInvite={onInvite} />);
    expect(screen.queryByTestId("invite-role-admin")).not.toBeInTheDocument();
    const options = Array.from(
      (screen.getByTestId("invite-role") as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(["member"]);
  });

  it("sends member for an admin even if admin was chosen while they were an owner", async () => {
    const onInvite = vi.fn<OnInvite>(async () => result(true));
    const { rerender } = render(<InviteForm canInviteAdmins onInvite={onInvite} />);
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "admin" } });
    rerender(<InviteForm canInviteAdmins={false} onInvite={onInvite} />);
    fill("bob@example.com");
    fireEvent.click(screen.getByTestId("invite-submit"));
    await waitFor(() => expect(onInvite).toHaveBeenCalledOnce());
    expect(onInvite).toHaveBeenCalledWith({ email: "bob@example.com", role: "member" });
  });

  it("with no email set up, shows the link to send by hand", async () => {
    const onInvite = vi.fn<OnInvite>(async () => result(false));
    render(<InviteForm canInviteAdmins onInvite={onInvite} />);
    fill("bob@example.com");
    fireEvent.click(screen.getByTestId("invite-submit"));

    const panel = await screen.findByTestId("invite-link-panel");
    expect(panel).toHaveTextContent(
      "Email is not set up on this server. Send this link to bob@example.com yourself.",
    );
    expect(screen.getByTestId("invite-link")).toHaveValue(
      "https://trackyourtime.dev/invite/?id=inv-1",
    );
    expect(screen.getByTestId("invite-link-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-sent")).not.toBeInTheDocument();
  });

  it("copies the link", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<InviteForm canInviteAdmins onInvite={async () => result(false)} />);
    fill("bob@example.com");
    fireEvent.click(screen.getByTestId("invite-submit"));
    fireEvent.click(await screen.findByTestId("invite-link-copy"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://trackyourtime.dev/invite/?id=inv-1"),
    );
  });

  it("with email set up, says it was sent and shows no link", async () => {
    render(<InviteForm canInviteAdmins onInvite={async () => result(true)} />);
    fill("bob@example.com");
    fireEvent.click(screen.getByTestId("invite-submit"));
    expect(await screen.findByTestId("invite-sent")).toHaveTextContent(
      "Invitation sent to bob@example.com.",
    );
    expect(screen.queryByTestId("invite-link")).not.toBeInTheDocument();
  });

  it("maps a server refusal code to copy", async () => {
    const onInvite = vi.fn<OnInvite>(async () => {
      throw Object.assign(new Error("already-member"), { data: { code: "FORBIDDEN" } });
    });
    render(<InviteForm canInviteAdmins onInvite={onInvite} />);
    fill("bob@example.com");
    fireEvent.click(screen.getByTestId("invite-submit"));
    const error = await screen.findByTestId("invite-error");
    expect(error).toHaveTextContent("This person is already a member of the workspace.");
    expect(error).not.toHaveTextContent("already-member");
  });
});

describe("membershipErrorMessage", () => {
  const forbidden = (code: string) =>
    Object.assign(new Error(code), { data: { code: "FORBIDDEN" } });

  it.each([
    ["owner-required", "Only an owner can do this."],
    ["admin-required", "Only an owner or an admin can do this."],
    ["cannot-modify-self", "You cannot change your own role or visibility."],
    ["cannot-modify-owner", "Only another owner can change an owner."],
    ["transfer-ownership-first", "Transfer ownership first. The workspace needs an owner."],
    ["workspace-has-no-other-members", "You are the only member of this workspace."],
    ["invitation-email-mismatch", "This invitation is for a different email address."],
    ["invitation-not-pending", "This invitation can no longer be accepted."],
    ["invite-limit-reached", "Too many invitations are waiting. Cancel some, or try again later."],
  ])("maps %s", (code, copy) => {
    expect(membershipErrorMessage(forbidden(code))).toBe(copy);
  });

  it("reads NOT_FOUND as a row that no longer exists", () => {
    const error = Object.assign(new Error("Not found"), { data: { code: "NOT_FOUND" } });
    expect(membershipErrorMessage(error)).toContain("no longer exists");
  });

  it("never echoes an unknown server message", () => {
    expect(membershipErrorMessage(new Error("TypeError: x is undefined at y.js:1"))).toBe(
      "Something went wrong. Try again.",
    );
  });
});
