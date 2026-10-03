// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  read: (): Promise<string | null> => Promise.resolve(null),
  replace: vi.fn(),
  originRead: (): Promise<string | null> => Promise.resolve(null),
  writes: [] as string[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: harness.replace }) }));
vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => "capacitor"),
);
vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: {
    setSynchronize: async () => undefined,
    getItem: () => harness.read(),
    setItem: async (_key: string, value: string) => { harness.writes.push(value); },
    removeItem: async () => undefined,
  },
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: key === "trackyourtime.installed" ? "1" : await harness.originRead() }),
    set: async () => undefined,
  },
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

const session = {
  session: { id: "s1", userId: "u1" },
  user: { id: "u1", name: "User", email: "user@example.test" },
};
const calls: { url: string; authorization: string | null }[] = [];
let respond: (authorization: string | null) => Response | Promise<Response>;
let release: ((token: string | null) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://default.example");
  calls.length = 0;
  release = undefined;
  harness.replace.mockClear();
  harness.originRead = async () => null;
  harness.writes.length = 0;
  harness.read = () => new Promise((resolve) => { release = resolve; });
  respond = (authorization) => Response.json(authorization ? session : null);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return respond(calls.at(-1)!.authorization);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function mount(strict = false) {
  const { AuthProvider, useAuth } = await import("./auth-provider");
  const { default: Layout } = await import("@/app/app/layout");
  function Identity() { return <p>{useAuth().user?.email ?? "offline"}</p>; }
  const tree = <AuthProvider><Layout><Identity /></Layout></AuthProvider>;
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  await waitFor(() => expect(release).toBeTypeOf("function"));
}

it("waits for secure storage, then validates once through protected navigation", async () => {
  await mount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(calls).toHaveLength(0);
  await act(async () => { release!("stored-token"); });
  await waitFor(() => expect(screen.getByText("user@example.test")).toBeTruthy());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.authorization).toBe("Bearer stored-token");
  expect(new URL(calls[0]!.url).searchParams.get("disableCookieCache")).toBe("true");
  expect(harness.replace).not.toHaveBeenCalled();
});

it("does not contact the session endpoint for a missing token", async () => {
  await mount();
  await act(async () => { release!(null); });
  await waitFor(() => expect(harness.replace).toHaveBeenCalledWith("/login"));
  expect(calls).toHaveLength(0);
});

it("routes a revoked token to login after one authoritative validation", async () => {
  respond = () => Response.json(null);
  await mount();
  await act(async () => { release!("revoked-token"); });
  await waitFor(() => expect(harness.replace).toHaveBeenCalledWith("/login"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(calls).toHaveLength(1);
  expect(screen.queryByTestId("app-shell")).toBeNull();
});

it.each(["offline", "server error"])("keeps the stored-token launch usable after %s", async (failure) => {
  respond = () => {
    if (failure === "offline") throw new TypeError("Failed to fetch");
    return Response.json({ message: "Unavailable" }, { status: 503 });
  };
  await mount();
  await act(async () => { release!("stored-token"); });
  await waitFor(() => expect(screen.getByTestId("app-shell")).toBeTruthy());
  expect(calls).toHaveLength(1);
  expect(harness.replace).not.toHaveBeenCalled();
});


it("shares the initial validation across Strict Mode mounts", async () => {
  await mount(true);
  await act(async () => { release!("stored-token"); });
  await waitFor(() => expect(screen.getByText("user@example.test")).toBeTruthy());
  expect(calls).toHaveLength(1);
});

it("waits for the chosen API origin before sending the stored token", async () => {
  let choose!: (value: string | null) => void;
  harness.originRead = () => new Promise((resolve) => { choose = resolve; });
  await mount();
  await act(async () => { release!("chosen-server-token"); });
  expect(calls).toHaveLength(0);
  await act(async () => { choose(JSON.stringify({ origin: "https://chosen.example" })); });
  await waitFor(() => expect(screen.getByTestId("app-shell")).toBeTruthy());
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://chosen.example/api/auth/get-session?disableCookieCache=true");
  expect(calls[0]?.authorization).toBe("Bearer chosen-server-token");
});

it("persists a refreshed token without another validation", async () => {
  respond = () => Response.json(session, { headers: { "set-auth-token": "refreshed-token" } });
  await mount();
  await act(async () => { release!("stored-token"); });
  await waitFor(() => expect(screen.getByTestId("app-shell")).toBeTruthy());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(calls).toHaveLength(1);
  expect(harness.writes).toEqual(["refreshed-token"]);
});

it("discards a late account response and validates the replacement token", async () => {
  let answer!: (response: Response) => void;
  respond = () => new Promise((resolve) => { answer = resolve; });
  await mount();
  await act(async () => { release!("old-token"); });
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  const native = await import("@/lib/native-session");
  await act(async () => { await native.setNativeToken("new-token"); });
  respond = () => Response.json({ ...session, user: { ...session.user, email: "new@example.test" } });
  await act(async () => { answer(Response.json(session, { headers: { "set-auth-token": "old-token" } })); });
  await waitFor(() => expect(screen.getByText("new@example.test")).toBeTruthy());
  expect(calls.map((call) => call.authorization)).toEqual(["Bearer old-token", "Bearer new-token"]);
  expect(native.getNativeToken()).toBe("new-token");
  expect(harness.writes).toEqual(["new-token"]);
  expect(harness.replace).not.toHaveBeenCalled();
});
