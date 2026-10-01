/** Remove legacy cross-app logout instructions. New sign-outs never write them. */
import { chromeStorage, localStorageArea } from "./chrome-storage";

export const SIGN_OUT_MARKER_STORAGE_KEY = "trackyourtime.web-sign-out-marker";
export const LINK_BLOCK_STORAGE_KEY = "trackyourtime.web-link-not-before";

export async function clearSignOutMarker(): Promise<void> {
  await chromeStorage(localStorageArea()).removeItem(SIGN_OUT_MARKER_STORAGE_KEY);
}

export async function clearLinkBlock(): Promise<void> {
  await chromeStorage(localStorageArea()).removeItem(LINK_BLOCK_STORAGE_KEY);
}
