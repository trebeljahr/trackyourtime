/**
 * The return trip from the shared donate page on ricos.site.
 *
 * After a payment that page returns to the originating web page with `supported=1`.
 * On arrival the marketing site records when that happened and takes the
 * parameter out of the address bar, so a bookmark or a shared link does not
 * carry it on.
 *
 * Nothing reads the value yet. It is for a later inline ask, which stays quiet
 * for 90 days after it — the same quiet period as ricos.site's own ask.
 */

export const DONATION_SUPPORTED_AT_KEY = "donation-supported-at";

const SUPPORTED_PAIR = "supported=1";

/** The parts of `window` this touches, so a test can hand in its own. */
export type DonationReturnWindow = {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: Pick<History, "replaceState">;
  readonly localStorage: Pick<Storage, "setItem">;
};

/**
 * Records a `?supported=1` arrival and removes that one parameter.
 *
 * Every other parameter and the hash are kept byte for byte: the query is
 * split on `&` rather than re-serialized through `URLSearchParams`, which
 * would re-encode values it did not need to touch.
 *
 * `replaceState` gets `null` as its state on purpose. Next's patched
 * `replaceState` copies its own history state over and syncs the router's
 * URL; handed a state that already carries Next's marker it skips the sync,
 * and the router would later write `?supported=1` back.
 *
 * Returns whether the parameter was there.
 */
export function recordDonationReturn(win: DonationReturnWindow, now: number = Date.now()): boolean {
  const pairs = win.location.search.replace(/^\?/, "").split("&");
  const kept = pairs.filter((pair) => pair !== SUPPORTED_PAIR);
  if (kept.length === pairs.length) return false;

  try {
    win.localStorage.setItem(DONATION_SUPPORTED_AT_KEY, String(now));
  } catch {
    // Storage blocked (private mode, site data off): the marker only quiets a
    // future ask, so losing it is not worth an error.
  }

  const query = kept.filter((pair) => pair !== "").join("&");
  win.history.replaceState(null, "", `${win.location.pathname}${query ? `?${query}` : ""}${win.location.hash}`);
  return true;
}
