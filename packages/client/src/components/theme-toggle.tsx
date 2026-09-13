"use client";

import * as React from "react";
import { Check, Laptop, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

/** Explicit user choice; "system" defers to `prefers-color-scheme`. */
export type ThemeChoice = "light" | "dark" | "system";

/** Where the choice is persisted. Must match the no-flash script in app/layout. */
export const THEME_STORAGE_KEY = "tracktime.theme";

const isThemeChoice = (value: unknown): value is ThemeChoice =>
  value === "light" || value === "dark" || value === "system";

const prefersDark = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * Set once the local choice has been reconciled with the server's.
 *
 * Its absence is what tells {@link ThemeSync} that this browser's stored
 * choice predates the theme being synced at all, and is therefore worth
 * pushing up rather than overwriting — see the migration note there.
 */
export const THEME_SYNCED_KEY = "tracktime.theme.synced";

const readStoredChoice = (): ThemeChoice => {
  if (typeof window === "undefined") return "system";
  try {
    const stored: unknown = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

/**
 * Writes the resolved theme onto `<html>` as a class. Both classes are
 * written explicitly (never just removed) so "system" still produces a
 * concrete class for the CSS `.dark` variant and for sonner's theme sniffing.
 */
export const applyTheme = (choice: ThemeChoice): "light" | "dark" => {
  const resolved: "light" | "dark" =
    choice === "system" ? (prefersDark() ? "dark" : "light") : choice;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  return resolved;
};

// ── shared state ─────────────────────────────────────────────────────
//
// The theme lives outside React: the no-flash script in app/layout.tsx has
// already written the class before the first render, and every consumer must
// observe the same value. `useSyncExternalStore` keeps that tear-free.

type ThemeState = {
  choice: ThemeChoice;
  resolved: "light" | "dark";
};

type Listener = () => void;

/**
 * Where a deliberate theme change is published, so it reaches the server.
 *
 * A module-level sink rather than a prop or a context, because the two things
 * that change the theme — the top bar's toggle and the settings screen — are
 * mounted in different trees, and the theme store they share is itself outside
 * React. {@link ThemeSync} registers it; with nothing registered the theme
 * still works, it just stays on this device.
 */
type ThemeSink = (choice: ThemeChoice) => void;

let sink: ThemeSink | null = null;

export const setThemeSink = (next: ThemeSink | null): void => {
  sink = next;
};

const SERVER_STATE: ThemeState = { choice: "system", resolved: "light" };

let state: ThemeState = SERVER_STATE;
let hydrated = false;
const listeners = new Set<Listener>();

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ThemeState => state;
const getServerSnapshot = (): ThemeState => SERVER_STATE;

/** The local copy the no-flash script in app/layout reads on the next load. */
const persistChoice = (choice: ThemeChoice): void => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* private mode — the theme just won't persist */
  }
};

/** Apply a choice to the DOM and publish it to every subscriber. */
const commitChoice = (choice: ThemeChoice): void => {
  const resolved = applyTheme(choice);
  if (state.choice === choice && state.resolved === resolved) return;
  state = { choice, resolved };
  for (const listener of listeners) listener();
};

/**
 * Apply a choice that came FROM the server.
 *
 * Deliberately does not reach the sink: echoing an adopted value back up would
 * write the server's own answer to it on every settings refetch.
 */
export const adoptTheme = (choice: ThemeChoice): void => {
  persistChoice(choice);
  commitChoice(choice);
};

export type UseThemeResult = {
  theme: ThemeChoice;
  /** What the choice currently resolves to — never "system". */
  resolved: "light" | "dark";
  setTheme: (next: ThemeChoice) => void;
};

/** Reads and writes the app theme. Persists the choice to localStorage. */
export const useTheme = (): UseThemeResult => {
  const snapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  React.useEffect(() => {
    // First mount picks up whatever the no-flash script already applied.
    if (!hydrated) {
      hydrated = true;
      commitChoice(readStoredChoice());
    }

    // "system" must keep tracking the OS for as long as the app is open.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      if (state.choice === "system") commitChoice("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = React.useCallback((next: ThemeChoice): void => {
    // Stored locally as well as sent, and in that order: localStorage is what
    // the no-flash script reads on the next load, so a round trip must never
    // stand between the click and the theme surviving a reload.
    persistChoice(next);
    commitChoice(next);
    sink?.(next);
  }, []);

  return {
    theme: snapshot.choice,
    resolved: snapshot.resolved,
    setTheme,
  };
};

/**
 * Labels are message KEYS, not text: a module-level constant is evaluated once
 * at import, before the locale is known, so translated text can never live
 * here. The component resolves them with `t` on every render.
 */
const OPTIONS = [
  { value: "light", labelKey: "theme.light", icon: Sun },
  { value: "dark", labelKey: "theme.dark", icon: Moon },
  { value: "system", labelKey: "theme.system", icon: Laptop },
] as const satisfies readonly { value: ThemeChoice; labelKey: string; icon: typeof Sun }[];

export type ThemeToggleProps = {
  className?: string;
};

/** Light / Dark / System menu for the top bar. */
export function ThemeToggle({ className }: ThemeToggleProps): React.JSX.Element {
  const { theme, resolved, setTheme } = useTheme();
  const t = useT("shell");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(className)}
          aria-label={t("theme.change")}
          data-testid="theme-toggle"
        >
          {resolved === "dark" ? (
            <Moon className="size-4" />
          ) : (
            <Sun className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="theme-menu">
        {OPTIONS.map(({ value, labelKey, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => setTheme(value)}
            data-testid={`theme-option-${value}`}
          >
            <Icon className="size-4" />
            <span>{t(labelKey)}</span>
            <Check
              className={cn(
                "ml-auto size-4",
                theme === value ? "opacity-100" : "opacity-0"
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
