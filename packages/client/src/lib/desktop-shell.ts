import {
  normalizeAccelerator,
  parseAccelerator,
  type DesktopNotice,
  type DesktopShell,
} from "@starter/shared";

import { isElectron } from "@/lib/shell";

/**
 * The desktop app's tray, shortcut and notification bridge, or null anywhere
 * else. Every caller in the web app goes through this, so a browser, the PWA
 * and the phones never reach for it.
 */
export function desktopShell(): DesktopShell | null {
  if (!isElectron()) return null;
  return window.electronAPI?.desktop ?? null;
}

/**
 * Ask the desktop app to post a notification for a prompt. The main process
 * posts it only while the window is hidden or behind another app, so a
 * caller does not have to know; a no-op outside the desktop app.
 */
export function notifyDesktop(notice: DesktopNotice): void {
  const shell = desktopShell();
  if (shell === null) return;
  void shell.notify(notice).catch(() => undefined);
}

/** `KeyboardEvent.code` → Electron's key name, for keys a shortcut may use. */
const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Return",
  NumpadEnter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "Fn",
  "CapsLock",
]);

export type RecordedKey =
  /** Only modifiers so far: keep listening. */
  | { kind: "pending" }
  /** Escape with no modifier: stop recording, change nothing. */
  | { kind: "cancel" }
  | { kind: "accelerator"; accelerator: string }
  /** A key and modifiers the app cannot register (a bare letter, Shift+A). */
  | { kind: "invalid"; attempted: string };

/**
 * What a key press in the recorder means.
 *
 * Read from `event.code`, the physical key, never `event.key`: on a Mac,
 * Option+T reports `key` "†", and on a German layout Shift+7 reports "/".
 * Electron's accelerators name keys by the US layout's legend, and so does
 * `code`. The Command key is `Command` on macOS and the Windows/Super key
 * `Super` elsewhere, so a recorded binding names the key that was pressed.
 */
export function recordKey(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): RecordedKey {
  if (MODIFIER_CODES.has(event.code) || event.code === "") return { kind: "pending" };
  const noModifier = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (event.code === "Escape" && noModifier) return { kind: "cancel" };

  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(event.code);
  const digit = /^Digit([0-9])$/.exec(event.code);
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.code);
  if (letter) key = letter[1] ?? null;
  else if (digit) key = digit[1] ?? null;
  else if (fn) key = event.code;
  else key = CODE_TO_KEY[event.code] ?? null;

  const mac = platform === "darwin";
  const modifiers = [
    event.metaKey ? (mac ? "Command" : "Super") : null,
    event.ctrlKey ? "Control" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter((modifier): modifier is string => modifier !== null);
  const attempted = [...modifiers, key ?? event.code].join("+");
  if (key === null) return { kind: "invalid", attempted };
  const accelerator = normalizeAccelerator(attempted);
  return accelerator === null ? { kind: "invalid", attempted } : { kind: "accelerator", accelerator };
}

/**
 * True for a Mac binding whose only modifiers are Option (and Shift) on a
 * character key: macOS types a character for that chord, which a global
 * shortcut then takes away from every text field.
 */
export function stealsTypedCharacter(accelerator: string, platform: string): boolean {
  if (platform !== "darwin") return false;
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return false;
  const onlyOption = parsed.modifiers.every((modifier) => modifier === "Alt" || modifier === "Shift");
  const typesCharacter = parsed.key.length === 1 || parsed.key === "Space";
  return onlyOption && parsed.modifiers.includes("Alt") && typesCharacter;
}

/** The translated words `formatAccelerator` needs off macOS. */
export type KeyWords = {
  ctrl: string;
  alt: string;
  shift: string;
  win: string;
  super: string;
  space: string;
  enter: string;
  escape: string;
  backspace: string;
  delete: string;
};

const MAC_ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };

/**
 * An accelerator as a person reads it: `⌃⌥⇧⌘Space` on a Mac, in the order
 * macOS menus use, and `Ctrl+Alt+Shift+Space` (`Strg+Alt+Umschalt+Leertaste`)
 * elsewhere.
 */
export function formatAccelerator(accelerator: string, platform: string, words: KeyWords): string {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return accelerator;
  const mac = platform === "darwin";
  const has = (name: string): boolean => parsed.modifiers.some((modifier) => modifier === name);
  const command = has("Command") || (mac && (has("CommandOrControl") || has("Super")));
  const control = has("Control") || (!mac && has("CommandOrControl"));
  const superKey = !mac && has("Super");

  const namedKey = (): string => {
    switch (parsed.key) {
      case "Space":
        return words.space;
      case "Return":
        return mac ? "↩" : words.enter;
      case "Escape":
        return mac ? "⎋" : words.escape;
      case "Backspace":
        return mac ? "⌫" : words.backspace;
      case "Delete":
        return mac ? "⌦" : words.delete;
      case "Plus":
        return "+";
      default:
        return mac ? (MAC_ARROWS[parsed.key] ?? parsed.key) : parsed.key;
    }
  };

  if (mac) {
    return `${control ? "⌃" : ""}${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${command ? "⌘" : ""}${namedKey()}`;
  }
  return [
    control ? words.ctrl : null,
    superKey ? (platform === "win32" ? words.win : words.super) : null,
    has("Alt") ? words.alt : null,
    has("Shift") ? words.shift : null,
    namedKey(),
  ]
    .filter((part): part is string => part !== null)
    .join("+");
}

/**
 * Focus the tracker's description field, waiting for it to mount when the
 * caller has just navigated to /app/track. Gives up quietly after `timeoutMs`.
 */
export function focusTrackerDescription(timeoutMs = 3000): void {
  const started = Date.now();
  const attempt = (): void => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="tracker-description"]');
    if (input) {
      input.focus();
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(attempt, 50);
  };
  attempt();
}
