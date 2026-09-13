/**
 * Opening the web app from the popup.
 *
 * Lifted out of `menu.tsx` because the overflow menu is no longer the only
 * thing that links out: Settings → Account offers "Open Track Your Time", and the
 * entries list points at the web app for anything older than its window. One
 * copy of the join rule keeps a stray double slash from being possible in
 * three places instead of one.
 */

export function openTab(url: string): void {
  // No `tabs` permission is needed to create one, and the popup is destroyed
  // as soon as focus leaves it — so nothing here has to survive the click.
  void chrome.tabs.create({ url });
}

/** Join an origin and an absolute path without doubling the slash between them. */
export function join(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}
