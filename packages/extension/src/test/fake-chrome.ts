/**
 * An in-memory `chrome` for unit tests.
 *
 * Covers exactly the APIs the worker modules under test call, with the same
 * promise-returning shapes MV3 has, plus a handle for driving it: the tabs and
 * windows that exist, which permissions are granted, and `emit` for firing
 * listeners the way Chrome would.
 */

type Listener = (...args: never[]) => unknown;

export type FakeEvent<L extends Listener> = {
  addListener: (listener: L) => void;
  removeListener: (listener: L) => void;
  hasListener: (listener: L) => boolean;
  emit: (...args: Parameters<L>) => void;
  listeners: L[];
};

const fakeEvent = <L extends Listener>(): FakeEvent<L> => {
  const listeners: L[] = [];
  return {
    listeners,
    addListener: (listener) => {
      listeners.push(listener);
    },
    removeListener: (listener) => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    hasListener: (listener) => listeners.includes(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
};

const storageArea = (): chrome.storage.StorageArea & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  const area = {
    data,
    get: async (keys?: string | string[] | null) => {
      const out: Record<string, unknown> = {};
      const wanted = keys === undefined || keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const key of wanted) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    clear: async () => {
      data.clear();
    },
  };
  return area as unknown as chrome.storage.StorageArea & { data: Map<string, unknown> };
};

export type FakeTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active: boolean;
  incognito: boolean;
};

export type FakeWindow = { id: number; focused: boolean; incognito: boolean };

export type FakeChrome = ReturnType<typeof createFakeChrome>;

export function createFakeChrome() {
  const tabs: FakeTab[] = [];
  const windows: FakeWindow[] = [{ id: 1, focused: true, incognito: false }];
  const granted = new Set<string>();
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const badge = { text: "" };

  const api = {
    runtime: {
      id: "fake-extension-id",
      onMessage: fakeEvent<(message: unknown, sender: unknown, respond: (r: unknown) => void) => boolean>(),
      onInstalled: fakeEvent<() => void>(),
      onStartup: fakeEvent<() => void>(),
      sendMessage: async () => undefined,
    },
    storage: {
      local: storageArea(),
      session: storageArea(),
    },
    permissions: {
      contains: async (request: chrome.permissions.Permissions) =>
        (request.permissions ?? []).every((permission) => granted.has(permission)),
      request: async (request: chrome.permissions.Permissions) => {
        for (const permission of request.permissions ?? []) granted.add(permission);
        return true;
      },
      remove: async (request: chrome.permissions.Permissions) => {
        for (const permission of request.permissions ?? []) granted.delete(permission);
        return true;
      },
      onAdded: fakeEvent<(permissions: chrome.permissions.Permissions) => void>(),
      onRemoved: fakeEvent<(permissions: chrome.permissions.Permissions) => void>(),
    },
    tabs: {
      query: async (info: { active?: boolean; windowId?: number }) =>
        tabs
          .filter((tab) => info.active === undefined || tab.active === info.active)
          .filter((tab) => info.windowId === undefined || tab.windowId === info.windowId)
          .map((tab) => ({ ...tab })),
      onActivated: fakeEvent<(info: { tabId: number; windowId: number }) => void>(),
      onUpdated: fakeEvent<(tabId: number, changeInfo: { url?: string; title?: string; status?: string }, tab: FakeTab) => void>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => {
        const focused = windows.find((win) => win.focused) ?? windows[0];
        return { ...(focused ?? { id: -1, focused: false, incognito: false }) };
      },
      onFocusChanged: fakeEvent<(windowId: number) => void>(),
    },
    alarms: {
      get: async (name: string) => alarms.get(name),
      create: async (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
        alarms.set(name, {
          name,
          scheduledTime: Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
          periodInMinutes: info.periodInMinutes,
          persistAcrossSessions: false,
        });
      },
      clear: async (name: string) => alarms.delete(name),
      getAll: async () => [...alarms.values()],
      onAlarm: fakeEvent<(alarm: chrome.alarms.Alarm) => void>(),
    },
    idle: {
      setDetectionInterval: () => undefined,
      queryState: async () => "active",
      onStateChanged: fakeEvent<(state: string) => void>(),
    },
    cookies: {
      get: async () => null,
      remove: async () => null,
      onChanged: fakeEvent<(change: unknown) => void>(),
    },
    action: {
      setBadgeText: async (details: { text: string }) => {
        badge.text = details.text;
      },
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
  };

  const control = {
    tabs,
    windows,
    granted,
    alarms,
    badge,
    /** Open (or replace) the one active tab of window 1. */
    showTab(tab: Partial<FakeTab> & { url: string }): FakeTab {
      const windowId = tab.windowId ?? 1;
      for (const other of tabs) if (other.windowId === windowId) other.active = false;
      const next: FakeTab = {
        id: tab.id ?? tabs.length + 1,
        windowId,
        url: tab.url,
        title: tab.title,
        active: true,
        incognito: tab.incognito ?? false,
      };
      tabs.push(next);
      return next;
    },
    focusWindow(id: number | null): void {
      for (const win of windows) win.focused = win.id === id;
    },
  };

  return { api, control };
}
