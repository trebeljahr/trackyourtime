/**
 * Asking Chrome for access to the one server a person chose.
 *
 * The store build declares broad `optional_host_permissions` and holds none of
 * them. When someone picks their own server, the popup asks for exactly that
 * host — `https://track.example.com/*` — and nothing else, so what Chrome
 * shows in its prompt and on `chrome://extensions` is the server they typed,
 * never "all sites".
 *
 * Every function takes the permissions API as an argument. That is for the
 * tests, and it is also honest about the dependency: the popup and the service
 * worker both call these, and `chrome.permissions` is the one piece of either
 * that a unit test cannot have.
 */

/** The subset of `chrome.permissions` this module uses. */
export type PermissionsApi = {
  request(permissions: { origins: string[] }): Promise<boolean>;
  contains(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
};

export type ServerAccessVerdict = "granted" | "refused";

/**
 * The match pattern that covers an origin: `<scheme>//<hostname>/*`.
 *
 * The port is dropped on purpose. A Chrome match pattern with no port matches
 * every port on the host, which is how the manifest's own patterns are written
 * (`http://localhost/*`), so the request is plainly a subset of what was
 * declared. It also means a server that moves port — every `pnpm run dev` in a
 * worktree does — needs no second prompt.
 *
 * Throws on a string that is not a URL; callers pass an origin that
 * `normalizeServerInput` already produced.
 */
export function originPermissionPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Ask Chrome for access to `origin`'s host.
 *
 * NOT an async function, and that is the whole point of it: Chrome only
 * honours `permissions.request` while a user gesture is active, and the
 * gesture ends at the first `await`. `request` is therefore called before this
 * function returns, and a caller must call this before awaiting anything
 * itself — see `switchServer`.
 *
 * Resolves `"refused"` for every way of not getting access: the person said
 * no, the pattern is not declared in the manifest (a development build asked
 * for an http host, say), or the call itself threw.
 */
export function requestServerAccess(
  origin: string,
  permissions: PermissionsApi,
): Promise<ServerAccessVerdict> {
  let pending: Promise<boolean>;
  try {
    pending = permissions.request({ origins: [originPermissionPattern(origin)] });
  } catch {
    return Promise.resolve("refused");
  }
  return pending.then(
    (granted): ServerAccessVerdict => (granted ? "granted" : "refused"),
    (): ServerAccessVerdict => "refused",
  );
}

/**
 * Whether the extension may currently reach `origin`.
 *
 * True for a host the build requires as well as for a granted optional one —
 * `contains` does not distinguish, and neither does anything that fetches.
 * A failure is `false`: the question is "can requests go there", and a
 * permissions API that cannot answer is not a yes.
 */
export async function hasServerAccess(
  origin: string,
  permissions: PermissionsApi,
): Promise<boolean> {
  try {
    return await permissions.contains({
      origins: [originPermissionPattern(origin)],
    });
  } catch {
    return false;
  }
}

/**
 * Give a host's access back.
 *
 * Best effort, and silent: Chrome refuses to remove a host the manifest
 * REQUIRES, which is exactly right for the build's default server, and there
 * is nothing a person could do about any other failure either.
 */
export async function releaseServerAccess(
  origin: string,
  permissions: PermissionsApi,
): Promise<void> {
  try {
    await permissions.remove({ origins: [originPermissionPattern(origin)] });
  } catch {
    /* required host, never granted, or already gone */
  }
}

/** Two origins Chrome grants and revokes together — same scheme and host, any port. */
export function sharesServerAccess(a: string, b: string): boolean {
  try {
    return originPermissionPattern(a) === originPermissionPattern(b);
  } catch {
    return false;
  }
}
