/**
 * A tiny Track Your Time server for the sign-in tests: `/api/health`, the
 * better-auth device flow, `get-session`, `sign-out`, and a tRPC surface that
 * answers every query with the membership list or null.
 */
import { vi } from "vitest";

export type DeviceTokenAnswer = "pending" | "approved" | "denied" | "expired" | "slow";

export type FakeAuthServer = {
  webUrl: string;
  healthFails: boolean;
  /** Every tRPC mutation fails in transport, as with the network gone. */
  mutationsFail: boolean;
  originTrusted: boolean | null;
  deviceCodeFails: boolean;
  verificationUrl: string;
  intervalSeconds: number;
  /** What `/device/token` answers next. */
  token: DeviceTokenAnswer;
  /** Who a token issued by `/device/token` belongs to. */
  approvedUser: { id: string; email: string } | null;
  /** Token → user, for `get-session`. */
  sessions: Map<string, { id: string; email: string }>;
  revoked: string[];
  calls: string[];
  issued: number;
};

export const API = "http://127.0.0.1:9";

export const createFakeAuthServer = (): FakeAuthServer => ({
  webUrl: "http://localhost:3392",
  healthFails: false,
  mutationsFail: false,
  originTrusted: true,
  deviceCodeFails: false,
  verificationUrl: "http://localhost:3392/app/device?user_code=ABCD-EFGH",
  intervalSeconds: 5,
  token: "pending",
  approvedUser: { id: "user-u", email: "u@example.com" },
  sessions: new Map(),
  revoked: [],
  calls: [],
  issued: 0,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const bearer = (init?: RequestInit): string | null => {
  const headers = new Headers(init?.headers);
  const value = headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
};

export const installFakeAuthServer = (server: FakeAuthServer): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const path = url.pathname;
      server.calls.push(path);

      if (path === "/api/health") {
        if (server.healthFails) throw new TypeError("fetch failed");
        return json(200, {
          status: "ok",
          service: "trackyourtime",
          webUrl: server.webUrl,
          originTrusted: server.originTrusted,
        });
      }
      if (path === "/api/auth/device/code") {
        if (server.deviceCodeFails) return json(500, { error: "server_error" });
        server.issued += 1;
        return json(200, {
          device_code: `device-${server.issued}`,
          user_code: "ABCDEFGH",
          verification_uri: server.webUrl,
          verification_uri_complete: server.verificationUrl,
          expires_in: 1800,
          interval: server.intervalSeconds,
        });
      }
      if (path === "/api/auth/device/token") {
        switch (server.token) {
          case "pending":
            return json(400, { error: "authorization_pending" });
          case "slow":
            return json(400, { error: "slow_down" });
          case "denied":
            return json(400, { error: "access_denied" });
          case "expired":
            return json(400, { error: "expired_token" });
          case "approved": {
            const token = `token-${server.sessions.size + 1}`;
            if (server.approvedUser !== null) server.sessions.set(token, server.approvedUser);
            // A device code is spent once.
            server.token = "denied";
            return json(200, { access_token: token, token_type: "Bearer", expires_in: 1 });
          }
        }
      }
      if (path === "/api/auth/get-session") {
        const user = server.sessions.get(bearer(init) ?? "");
        return user === undefined ? json(200, null) : json(200, { user, session: {} });
      }
      if (path === "/api/auth/sign-out") {
        const token = bearer(init);
        if (token !== null) {
          server.revoked.push(token);
          server.sessions.delete(token);
        }
        return json(200, { success: true });
      }
      if (path.startsWith("/api/trpc/")) {
        const procedure = path.slice("/api/trpc/".length);
        if (server.mutationsFail && init?.method === "POST") throw new TypeError("fetch failed");
        if (procedure === "workspaces.list") {
          return json(200, {
            result: {
              data: [
                {
                  id: "ws-1",
                  name: "Acme",
                  role: "member",
                  memberCount: 1,
                  isDefault: true,
                  permissions: {},
                },
              ],
            },
          });
        }
        if (procedure === "settings.get") {
          const user = server.sessions.get(bearer(init) ?? "");
          return json(200, {
            result: { data: user === undefined ? null : { userId: user.id, workspaceId: "ws-1" } },
          });
        }
        if (init?.method === "POST") return json(200, { result: { data: null } });
        if (procedure === "entries.current") return json(200, { result: { data: null } });
        if (procedure === "entries.list") {
          return json(200, { result: { data: { entries: [], nextCursor: null } } });
        }
        // Every other read is a list.
        return json(200, { result: { data: [] } });
      }
      return json(404, {});
    }),
  );
};
