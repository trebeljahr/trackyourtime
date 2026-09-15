// @vitest-environment jsdom
/**
 * The public invitation page, state by state.
 *
 * The leak-shaped cases matter most: a signed-in account whose email is not
 * the invited one sees an explanation and NO Accept button; nothing on the
 * page names anybody but the inviter and the invitee; and sign-in and signup
 * both carry the page's own address back as a validated `next`.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  type InvitationPreview,
} from "@starter/shared";

let searchId: string | null = "inv-1";
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => (key === "id" ? searchId : null) }),
}));

type AuthUser = { id: string; name: string; email: string } | null;
const auth: { user: AuthUser; isLoading: boolean } = { user: null, isLoading: false };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ ...auth, isAuthenticated: auth.user !== null }),
}));
vi.mock("@/hooks/use-native-session", () => ({
  useNativeSession: () => ({ token: null, ready: true }),
}));

const signOut = vi.fn(async () => undefined);
vi.mock("@/lib/auth-client", () => ({ signOut: () => signOut() }));

type PreviewState =
  | { kind: "data"; data: InvitationPreview }
  | { kind: "error"; code: string }
  | { kind: "pending" };
let previewState: PreviewState = { kind: "pending" };
const previewQuery = vi.fn();
const accept = vi.fn(async (_input: { id: string }) => ({ workspaceId: "ws-team" }));
const decline = vi.fn(async (_input: { id: string }) => ({ ok: true }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    invitations: {
      preview: {
        useQuery: (input: { id: string }, options: { enabled?: boolean }) => {
          previewQuery(input, options);
          const refetch = vi.fn();
          if (options.enabled === false) {
            return { data: undefined, isError: false, error: null, refetch };
          }
          if (previewState.kind === "data") {
            return { data: previewState.data, isError: false, error: null, refetch };
          }
          if (previewState.kind === "error") {
            const error = Object.assign(new Error("x"), { data: { code: previewState.code } });
            return { data: undefined, isError: true, error, refetch };
          }
          return { data: undefined, isError: false, error: null, refetch };
        },
      },
      accept: { useMutation: () => ({ mutateAsync: accept, isPending: false }) },
      decline: { useMutation: () => ({ mutateAsync: decline, isPending: false }) },
    },
  },
}));

const { InviteAcceptance, sameEmail } = await import("./invite-acceptance");

const invitation = (overrides: Partial<InvitationPreview> = {}): InvitationPreview => ({
  id: "inv-1",
  workspaceName: "Studio",
  inviterName: "Olivia",
  email: "bob@example.com",
  role: "member",
  status: "pending",
  ...overrides,
});

const show = (overrides: Partial<InvitationPreview> = {}): void => {
  previewState = { kind: "data", data: invitation(overrides) };
};

beforeEach(() => {
  searchId = "inv-1";
  auth.user = null;
  auth.isLoading = false;
  previewState = { kind: "pending" };
  previewQuery.mockClear();
  accept.mockClear();
  decline.mockClear();
  signOut.mockClear();
  window.localStorage.clear();
});

afterEach(cleanup);

const hrefOf = (testId: string): URL =>
  new URL(screen.getByTestId(testId).getAttribute("href") ?? "", "https://app.test");

describe("InviteAcceptance signed out", () => {
  it("previews the invitation and links to sign in and signup with next and email", () => {
    show({ role: "admin" });
    render(<InviteAcceptance navigate={vi.fn()} />);

    expect(screen.getByTestId("invite-headline")).toHaveTextContent(
      "Olivia invited bob@example.com to Studio as an admin.",
    );
    expect(previewQuery).toHaveBeenCalledWith({ id: "inv-1" }, expect.anything());

    for (const [testId, page] of [
      ["invite-sign-in", "login"],
      ["invite-create-account", "signup"],
    ] as const) {
      const url = hrefOf(testId);
      expect(url.pathname).toMatch(new RegExp(`^/${page}/?$`));
      expect(url.searchParams.get("next")).toBe("/invite/?id=inv-1");
      expect(url.searchParams.get("email")).toBe("bob@example.com");
    }
    expect(screen.queryByTestId("invite-accept")).not.toBeInTheDocument();
  });
});

describe("InviteAcceptance signed in with the invited email", () => {
  beforeEach(() => {
    auth.user = { id: "u-bob", name: "Bob", email: "Bob@Example.com " };
  });

  it("accepts, stores the workspace and reloads into /track/", async () => {
    show();
    const navigate = vi.fn();
    render(<InviteAcceptance navigate={navigate} />);

    fireEvent.click(screen.getByTestId("invite-accept"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/track/"));
    expect(accept).toHaveBeenCalledWith({ id: "inv-1" });
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-team");
  });

  it("declines", async () => {
    show();
    render(<InviteAcceptance navigate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("invite-decline"));
    expect(await screen.findByTestId("invite-declined")).toBeInTheDocument();
    expect(decline).toHaveBeenCalledWith({ id: "inv-1" });
  });

  it("explains a refusal from the server instead of navigating", async () => {
    show();
    accept.mockRejectedValueOnce(
      Object.assign(new Error("invitation-not-pending"), { data: { code: "FORBIDDEN" } }),
    );
    const navigate = vi.fn();
    render(<InviteAcceptance navigate={navigate} />);
    fireEvent.click(screen.getByTestId("invite-accept"));
    expect(await screen.findByTestId("invite-error")).toHaveTextContent(
      "This invitation can no longer be accepted.",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBeNull();
  });
});

describe("InviteAcceptance signed in with a different email", () => {
  beforeEach(() => {
    auth.user = { id: "u-eve", name: "Eve", email: "eve@example.com" };
  });

  it("explains which address the invitation is for and offers no Accept", () => {
    show();
    render(<InviteAcceptance navigate={vi.fn()} />);
    const mismatch = screen.getByTestId("invite-mismatch");
    expect(mismatch).toHaveTextContent("This invitation is for bob@example.com");
    expect(mismatch).toHaveTextContent("You are signed in as eve@example.com.");
    expect(screen.queryByTestId("invite-accept")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-decline")).not.toBeInTheDocument();
  });

  it("signs out and goes to sign-in with next preserved", async () => {
    show();
    const navigate = vi.fn();
    render(<InviteAcceptance navigate={navigate} />);
    fireEvent.click(screen.getByTestId("invite-switch-account"));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(signOut).toHaveBeenCalledOnce();
    const url = new URL(String(navigate.mock.calls[0]?.[0]), "https://app.test");
    expect(url.pathname).toBe("/login/");
    expect(url.searchParams.get("next")).toBe("/invite/?id=inv-1");
    expect(url.searchParams.get("email")).toBe("bob@example.com");
  });
});

describe("InviteAcceptance statuses", () => {
  beforeEach(() => {
    auth.user = { id: "u-bob", name: "Bob", email: "bob@example.com" };
  });

  it.each([
    ["expired", "invite-expired", "This invitation has expired"],
    ["canceled", "invite-canceled", "This invitation was canceled"],
    ["accepted", "invite-accepted", "This invitation was already accepted"],
    ["rejected", "invite-rejected", "This invitation was declined"],
  ] as const)("%s shows its state and no Accept", (status, testId, copy) => {
    show({ status });
    render(<InviteAcceptance navigate={vi.fn()} />);
    expect(screen.getByTestId(testId)).toHaveTextContent(copy);
    expect(screen.queryByTestId("invite-accept")).not.toBeInTheDocument();
  });

  it("an unknown id shows not found", () => {
    previewState = { kind: "error", code: "NOT_FOUND" };
    render(<InviteAcceptance navigate={vi.fn()} />);
    expect(screen.getByTestId("invite-not-found")).toHaveTextContent("Invitation not found");
  });

  it("a missing id shows not found without asking the server", () => {
    searchId = null;
    render(<InviteAcceptance navigate={vi.fn()} />);
    expect(screen.getByTestId("invite-not-found")).toBeInTheDocument();
    for (const [, options] of previewQuery.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ enabled: false }));
    }
  });

  it("a network failure offers a retry, not a verdict", () => {
    previewState = { kind: "error", code: "INTERNAL_SERVER_ERROR" };
    render(<InviteAcceptance navigate={vi.fn()} />);
    expect(screen.getByTestId("invite-load-error")).toBeInTheDocument();
    expect(screen.getByTestId("invite-retry")).toBeInTheDocument();
  });
});

describe("sameEmail", () => {
  it("ignores case and surrounding space, and never matches empty", () => {
    expect(sameEmail(" Bob@Example.com", "bob@example.com")).toBe(true);
    expect(sameEmail("eve@example.com", "bob@example.com")).toBe(false);
    expect(sameEmail("", "")).toBe(false);
    expect(sameEmail(null, undefined)).toBe(false);
  });
});
