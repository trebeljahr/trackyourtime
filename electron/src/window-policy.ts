import type { DesktopSettings } from "../../packages/shared/src/desktop-bridge.ts";

/** GNOME gets a useful timer without depending on an indicator extension. */
export function defaultWindowMode(platform: string, env: Record<string, string | undefined>): "full" | "compact" {
  return platform === "linux" && (env.XDG_CURRENT_DESKTOP ?? "").split(/[:;]/).some((name) => name.trim().toLowerCase() === "gnome")
    ? "compact" : "full";
}

/** A tray object does not prove the desktop displays it (notably GNOME). */
export function desktopWindowPolicy(
  platform: string,
  settings: Pick<DesktopSettings, "showInTray" | "closeHides">,
): { hideOnClose: boolean; allowHiddenLaunch: boolean } {
  const background = settings.showInTray && settings.closeHides;
  return {
    hideOnClose: platform === "darwin" || background,
    // Linux must explicitly opt into background operation first. Windows
    // retains its existing tray launch; macOS retains its normal window.
    allowHiddenLaunch: settings.showInTray && (platform === "win32" || (platform === "linux" && background)),
  };
}
