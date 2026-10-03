import { Capacitor, registerPlugin } from "@capacitor/core";
import { getAbsoluteApiOrigin, subscribeApiOrigin, whenApiOriginReady } from "@/lib/api-origin";

export type SavedPassword = { email: string; password: string };

const plugin = registerPlugin<{
  getPassword(options: { apiOrigin: string }): Promise<SavedPassword>;
  cancel(): Promise<void>;
}>("PasswordManager");

export const canUseAndroidPasswords = (): boolean =>
  Capacitor.getPlatform() === "android" &&
  Capacitor.isPluginAvailable("PasswordManager") &&
  getAbsoluteApiOrigin() === "https://api.trackyourtime.dev";

/** Do not let an in-flight website password fill a newly selected server's form. */
export async function getAndroidPassword(signal: AbortSignal): Promise<SavedPassword | null> {
  await whenApiOriginReady();
  if (signal.aborted || !canUseAndroidPasswords()) return null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    void plugin.cancel().catch(() => undefined);
  };
  const unsubscribe = subscribeApiOrigin(cancel);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await plugin.getPassword({ apiOrigin: getAbsoluteApiOrigin() });
    return cancelled || signal.aborted || !canUseAndroidPasswords() ? null : result;
  } catch (error) {
    if (cancelled || signal.aborted || (error as { code?: string })?.code === "CANCELLED") return null;
    throw error;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", cancel);
  }
}
