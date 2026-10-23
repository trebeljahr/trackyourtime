import type { DesktopTrayLabels } from "../../packages/shared/src/desktop-bridge.ts";

/** Launcher tasks remain usable when Windows has put the tray in overflow. */
export function windowsUserTasks(input: {
  platform: string;
  isPackaged: boolean;
  headless: boolean;
  execPath: string;
  labels: Pick<DesktopTrayLabels, "open" | "compactTimer">;
}) {
  if (input.platform !== "win32" || !input.isPackaged || input.headless)
    return null;
  return [
    {
      program: input.execPath,
      arguments: "--full-window",
      title: input.labels.open,
      description: input.labels.open,
      iconPath: input.execPath,
      iconIndex: 0,
    },
    {
      program: input.execPath,
      arguments: "--compact-timer",
      title: input.labels.compactTimer,
      description: input.labels.compactTimer,
      iconPath: input.execPath,
      iconIndex: 0,
    },
  ];
}

export function requestedWindowMode(
  argv: readonly string[],
): "full" | "compact" | null {
  if (argv.includes("--full-window")) return "full";
  return argv.includes("--compact-timer") ? "compact" : null;
}
