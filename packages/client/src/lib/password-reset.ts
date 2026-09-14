import { getApiOrigin, whenApiOriginReady } from "@/lib/api-origin";

/**
 * Ask the API to email a password-reset link.
 *
 * Two things here are load-bearing and both fail silently when got wrong,
 * which is why they live in one named function rather than inline in the page.
 *
 * **`redirectTo` must be absolute.** It is where the user lands after
 * better-auth has validated the token, and better-auth resolves it against
 * its OWN base URL — `new URL(callbackURL, ctx.baseURL)`, where `ctx.baseURL`
 * is `<BETTER_AUTH_URL>/api/auth`. A relative `/reset-password` therefore
 * resolves onto the API host, which has no such page and answers
 * `{"error":"Not found"}`. That only ever worked while the API was
 * same-origin with the web app; it no longer is. `FRONTEND_URL` puts this
 * origin in the server's trusted origins, which is what makes better-auth's
 * `originCheck` accept an absolute one rather than rejecting it as
 * `INVALID_REDIRECT_URL`.
 *
 * **The endpoint is `/request-password-reset`.** `/forget-password` is the
 * pre-1.6 name and is not mounted any more, so a POST to it 404s — and since
 * this flow deliberately reports success whatever the server says (never leak
 * whether an address has an account), a wrong path is invisible from the UI.
 * Hence the `res.ok` check: an unknown email is a 200, so anything else is a
 * real failure and worth showing.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  // The server this device signs in to — on the phone apps, the one picked on
  // the login screen rather than the one the build was made for.
  await whenApiOriginReady();
  const apiOrigin = getApiOrigin() || window.location.origin;

  const res = await fetch(`${apiOrigin}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    }),
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(`Password reset request failed: ${res.status}`);
  }
}
