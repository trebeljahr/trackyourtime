import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@starter/server/trpc";
import { isNative } from "@/mobile/bridge";
import { getNativeToken } from "@/lib/native-session";
import { rebaseApiUrl, whenApiOriginReady } from "@/lib/api-origin";

export const trpc = createTRPCReact<AppRouter>();

export function getTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${process.env.NEXT_PUBLIC_API_URL || ""}/api/trpc`,
        /**
         * The native shells authenticate with a bearer token, not a cookie: a
         * `capacitor://localhost` document is cross-site to the API whatever
         * SameSite says. With no token — every web request — this is exactly
         * `credentials: "include"` and no `authorization` header, which
         * `src/lib/trpc.test.ts` asserts rather than assumes.
         */
        fetch(url, options) {
          if (!isNative()) {
            const token = getNativeToken();
            return fetch(url, {
              ...options,
              credentials: token ? "omit" : "include",
            });
          }
          // The phone apps choose their server at runtime (`lib/api-origin.ts`).
          // The link above keeps the build-time URL; the request is rebased
          // here, and only once the stored choice has been read, so nothing
          // can leave for a server the person has already moved away from.
          return whenApiOriginReady().then(() => {
            const token = getNativeToken();
            return fetch(rebaseApiUrl(String(url)), {
              ...options,
              credentials: token ? "omit" : "include",
            });
          });
        },
        headers: () => {
          const token = getNativeToken();
          return {
            "x-trackyourtime-client": isNative() ? "trackyourtime-mobile" : "web",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          };
        },
      }),
    ],
  });
}
