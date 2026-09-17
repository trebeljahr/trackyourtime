import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Keychain-backed session token.
 *
 * Three behaviours here are the difference between an app that stays signed
 * in and one that quietly signs a user into somebody else's account, or wipes
 * its own credential:
 *
 *  - a fresh install must not inherit the previous install's Keychain item;
 *  - a relaunch must find the token that was stored;
 *  - a falsy write must never land, because `set-auth-token` is absent on
 *    most authenticated responses.
 */

type Harness = {
  keychain: Map<string, string>;
  preferences: Map<string, string>;
  module: typeof import("@/lib/native-session");
};

const load = async (options: {
  native?: boolean;
  keychain?: Record<string, string>;
  preferences?: Record<string, string>;
} = {}): Promise<Harness> => {
  vi.resetModules();

  const keychain = new Map(Object.entries(options.keychain ?? {}));
  const preferences = new Map(Object.entries(options.preferences ?? {}));

  vi.doMock("@/lib/shell", async () =>
    (await import("@/lib/shell-mock")).mockShellModule(() =>
      (options.native ?? true) ? "capacitor" : "web",
    ),
  );
  vi.doMock("@aparajita/capacitor-secure-storage", () => ({
    SecureStorage: {
      setSynchronize: async () => undefined,
      getItem: async (key: string) => keychain.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        keychain.set(key, value);
      },
      removeItem: async (key: string) => {
        keychain.delete(key);
      },
    },
  }));
  vi.doMock("@capacitor/preferences", () => ({
    Preferences: {
      get: async ({ key }: { key: string }) => ({
        value: preferences.get(key) ?? null,
      }),
      set: async ({ key, value }: { key: string; value: string }) => {
        preferences.set(key, value);
      },
    },
  }));

  const module = await import("@/lib/native-session");
  return { keychain, preferences, module };
};

const TOKEN_KEY = "trackyourtime.session-token";
const MARKER_KEY = "trackyourtime.installed";

beforeEach(() => {
  vi.resetModules();
});

describe("hydrateNativeSession on web", () => {
  it("is inert and resolves ready immediately", async () => {
    const { module } = await load({ native: false });

    await module.hydrateNativeSession();

    expect(module.getNativeToken()).toBeNull();
    expect(module.isNativeSessionReady()).toBe(true);
  });

  it("stores nothing, so no web request can ever carry a bearer token", async () => {
    const { module, keychain } = await load({ native: false });

    await module.setNativeToken("web-should-never-store-this");

    expect(module.getNativeToken()).toBeNull();
    expect(keychain.size).toBe(0);
  });
});

describe("hydrateNativeSession on native", () => {
  it("reads a token left by a previous launch", async () => {
    const { module } = await load({
      keychain: { [TOKEN_KEY]: "stored-token" },
      preferences: { [MARKER_KEY]: "1" },
    });

    await module.hydrateNativeSession();

    expect(module.getNativeToken()).toBe("stored-token");
    expect(module.getNativeSession()).toEqual({
      token: "stored-token",
      ready: true,
    });
  });

  it("discards a token that survived the app being deleted", async () => {
    // iOS leaves Keychain items in place when an app is deleted. Preferences
    // is wiped, so an absent marker means "this install has never run" —
    // and a reinstall must not resume, possibly into a previous user's
    // account on a handed-down phone.
    const { module, keychain, preferences } = await load({
      keychain: { [TOKEN_KEY]: "previous-installs-token" },
      preferences: {},
    });

    await module.hydrateNativeSession();

    expect(module.getNativeToken()).toBeNull();
    expect(keychain.has(TOKEN_KEY)).toBe(false);
    expect(preferences.get(MARKER_KEY)).toBe("1");
  });

  it("only does the fresh-install wipe once", async () => {
    const { module, keychain, preferences } = await load({ preferences: {} });

    await module.hydrateNativeSession();
    await module.setNativeToken("issued-after-sign-in");

    // A second launch of the same install: the marker is there now.
    const relaunch = await load({
      keychain: Object.fromEntries(keychain),
      preferences: Object.fromEntries(preferences),
    });
    await relaunch.module.hydrateNativeSession();

    expect(relaunch.module.getNativeToken()).toBe("issued-after-sign-in");
  });

  it("survives a Keychain that cannot be read", async () => {
    vi.resetModules();
    vi.doMock("@/lib/shell", async () =>
      (await import("@/lib/shell-mock")).mockShellModule(() => "capacitor"),
    );
    vi.doMock("@aparajita/capacitor-secure-storage", () => ({
      SecureStorage: {
        setSynchronize: async () => undefined,
        getItem: async () => {
          throw new Error("device is locked");
        },
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
    }));
    vi.doMock("@capacitor/preferences", () => ({
      Preferences: {
        get: async () => ({ value: "1" }),
        set: async () => undefined,
      },
    }));

    const module = await import("@/lib/native-session");
    await module.hydrateNativeSession();

    // Signed out, not crashed — this runs on the launch path, behind a splash
    // screen that only hides once React has mounted.
    expect(module.getNativeToken()).toBeNull();
    expect(module.isNativeSessionReady()).toBe(true);
  });
});

describe("a plugin handle that behaves like a thenable", () => {
  it("does not hang hydration", async () => {
    // A Capacitor plugin handle is a Proxy answering every property with a
    // callable, `then` included. Anything that returns one from an async
    // function has the promise machinery call `.then(resolve, reject)` on it,
    // which dispatches a bridge message for a native method nobody
    // implements: no resolve, no reject, and an app frozen behind a splash
    // screen that never auto-hides. This is that shape, in a test.
    vi.resetModules();
    vi.doMock("@/lib/shell", async () =>
      (await import("@/lib/shell-mock")).mockShellModule(() => "capacitor"),
    );
    vi.doMock("@aparajita/capacitor-secure-storage", () => {
      const backing = new Map<string, string>([[TOKEN_KEY, "stored-token"]]);
      const impl: Record<string, unknown> = {
        setSynchronize: async () => undefined,
        getItem: async (key: string) => backing.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: async (key: string) => {
          backing.delete(key);
        },
      };
      const SecureStorage = new Proxy(impl, {
        get: (target, prop) =>
          Reflect.get(target, prop) ??
          // Every unknown property — `then` above all — answers with a call
          // into a bridge that will never come back.
          (() => new Promise(() => undefined)),
      });
      return { SecureStorage };
    });
    vi.doMock("@capacitor/preferences", () => ({
      Preferences: {
        get: async () => ({ value: "1" }),
        set: async () => undefined,
      },
    }));

    const module = await import("@/lib/native-session");

    await Promise.race([
      module.hydrateNativeSession(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hydration hung")), 1000),
      ),
    ]);

    expect(module.getNativeToken()).toBe("stored-token");
  });
});

describe("the desktop app's token store", () => {
  const loadDesktop = async (stored: string | null) => {
    vi.resetModules();
    const calls: string[] = [];
    let file = stored;
    const secureStore = {
      getToken: async () => {
        calls.push("get");
        return file;
      },
      setToken: async (token: string) => {
        calls.push(`set:${token}`);
        file = token;
        return { persistent: true, backend: "keychain" };
      },
      deleteToken: async () => {
        calls.push("delete");
        file = null;
      },
      status: async () => ({ persistent: true, backend: "keychain" }),
    };
    vi.stubGlobal("window", { electronAPI: { isDesktop: true, secureStore } });
    vi.doMock("@/lib/shell", async () =>
      (await import("@/lib/shell-mock")).mockShellModule(() => "electron"),
    );
    // Neither Capacitor plugin may be touched in the desktop app.
    vi.doMock("@aparajita/capacitor-secure-storage", () => {
      throw new Error("the Keychain plugin was loaded in the desktop app");
    });
    vi.doMock("@capacitor/preferences", () => {
      throw new Error("Preferences was loaded in the desktop app");
    });
    const module = await import("@/lib/native-session");
    return { module, calls, file: () => file };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates from the main process, with no fresh-install wipe", async () => {
    const { module, calls } = await loadDesktop("desktop-token");

    await module.hydrateNativeSession();

    expect(module.getNativeToken()).toBe("desktop-token");
    expect(calls).toEqual(["get"]);
  });

  it("hands a new token to the main process and deletes it on sign-out", async () => {
    const { module, calls, file } = await loadDesktop(null);

    await module.hydrateNativeSession();
    await module.setNativeToken("issued");
    expect(file()).toBe("issued");

    await module.clearNativeToken();
    expect(module.getNativeToken()).toBeNull();
    expect(file()).toBeNull();
    expect(calls).toEqual(["get", "set:issued", "delete"]);
  });
});

describe("setNativeToken", () => {
  it("refuses to write a falsy value over a good token", async () => {
    // better-auth's bearer plugin only emits `set-auth-token` when the
    // response actually carries a session cookie, so most authenticated
    // calls have no header. Storing `headers.get(...)` unconditionally would
    // erase the credential on the first `/get-session`.
    const { module, keychain } = await load({ preferences: { [MARKER_KEY]: "1" } });

    await module.hydrateNativeSession();
    await module.setNativeToken("good-token");
    await module.setNativeToken("");

    expect(module.getNativeToken()).toBe("good-token");
    expect(keychain.get(TOKEN_KEY)).toBe("good-token");
  });
});

describe("clearNativeToken", () => {
  it("forgets the token in memory and in the Keychain", async () => {
    const { module, keychain } = await load({
      keychain: { [TOKEN_KEY]: "stored-token" },
      preferences: { [MARKER_KEY]: "1" },
    });

    await module.hydrateNativeSession();
    await module.clearNativeToken();

    expect(module.getNativeToken()).toBeNull();
    expect(keychain.has(TOKEN_KEY)).toBe(false);
  });
});
