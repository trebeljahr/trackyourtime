/** Email callbacks belong to this server's web app, never a native shell. */
export function emailLinkForWeb(url: string, frontendUrl: string): string {
  const link = new URL(url);
  const frontend = new URL(frontendUrl);
  if (!["http:", "https:"].includes(frontend.protocol)) {
    throw new Error("FRONTEND_URL must be an HTTP(S) web address");
  }
  const fallback = link.pathname.includes("/reset-password/")
    ? "/reset-password"
    : "/login";
  const supplied = link.searchParams.get("callbackURL");
  let path = fallback;
  if (supplied) {
    try {
      const callback = new URL(supplied, frontend);
      // Retain navigation state but never an arbitrary callback host.
      path = callback.pathname + callback.search + callback.hash;
    } catch {
      /* Use the appropriate auth page for malformed callbacks. */
    }
  }
  // Assign components separately: a pathname starting // must not become a host.
  const target = new URL(frontend.origin);
  const parsed = new URL(path, "https://callback.invalid");
  if (parsed.origin === "https://callback.invalid") {
    target.pathname = parsed.pathname;
    target.search = parsed.search;
    target.hash = parsed.hash;
  } else {
    target.pathname = fallback;
  }
  link.searchParams.set("callbackURL", target.href);
  return link.href;
}
