/*
 * Test helper: a `@/lib/shell` module with every predicate driven by the
 * caller, for `vi.mock("@/lib/shell", …)`. Mocking the module wholesale is
 * needed because the real predicates call each other internally, which a
 * partial mock of one export would not reach.
 *
 * Never imported by application code.
 */
import type { EntrySource } from "@starter/shared";

export type MockShell = "web" | "capacitor" | "electron";

export const mockShellModule = (current: () => MockShell) => ({
  isCapacitor: (): boolean => current() === "capacitor",
  isElectron: (): boolean => current() === "electron",
  isTokenShell: (): boolean => current() !== "web",
  isAppShell: (): boolean => current() !== "web",
  clientId: (): "web" | "trackyourtime-mobile" | "trackyourtime-desktop" =>
    current() === "capacitor"
      ? "trackyourtime-mobile"
      : current() === "electron"
        ? "trackyourtime-desktop"
        : "web",
  entrySource: (): EntrySource =>
    current() === "capacitor" ? "mobile" : current() === "electron" ? "desktop" : "web",
  shellTrustedOrigins: (): string =>
    current() === "electron" ? "app://-" : "capacitor://localhost,https://localhost",
});

/** The old boolean `isNative` mocks, as a shell. */
export const capacitorWhen = (native: boolean): MockShell => (native ? "capacitor" : "web");
