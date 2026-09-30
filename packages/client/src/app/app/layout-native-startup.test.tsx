// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const replace = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isLoading: true, isAuthenticated: false }),
}));
vi.mock("@/hooks/use-native-session", () => ({
  useNativeSession: () => ({ token: null, ready: true }),
}));
vi.mock("@/lib/auth-client", () => ({ getSession }));
vi.mock("@/lib/shell", () => ({ isTokenShell: () => true }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
import ProtectedLayout from "./layout";
afterEach(cleanup);
it("takes a fresh native install to login without waiting for the network", async () => {
  render(<ProtectedLayout>private data</ProtectedLayout>);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  expect(getSession).not.toHaveBeenCalled();
});
