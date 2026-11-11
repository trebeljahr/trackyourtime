// The desktop bridge: `window.electronAPI`, typed as `DesktopBridge` in
// packages/shared/src/desktop-bridge.ts. Installed by the shell as an
// initialization script, so it exists before any page script runs (the
// pre-paint script reads `platform` synchronously).
//
// Only the app's own top-level document gets it. The shell checks every call
// again (src/ipc.rs): this script runs per navigation, not per origin, and a
// page that ever showed something else must not hold a working bridge.
//
// The name `electronAPI` is the contract the web app compiles against; it
// predates the move to Tauri and stays so the renderer did not change.
(function (cfg) {
  "use strict";
  if (window !== window.top) return;
  var here = location.protocol + "//" + location.host;
  if (here !== cfg.origin && !(cfg.devOrigin && here === cfg.devOrigin)) return;
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return;

  // The page counts as visible while the window is hidden, as it did under
  // Electron's `backgroundThrottling: false` (which covers the Page
  // Visibility API too). The hidden window is where the timer, the offline
  // queue, the sync socket, private-workspace sync and idle detection run, and
  // the renderer pauses work for a hidden document. The WebView's own
  // visibilitychange is swallowed, since Electron never sent one.
  try {
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, enumerable: true, get: function () { return "visible"; } });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, enumerable: true, get: function () { return false; } });
    window.addEventListener("visibilitychange", function (event) { event.stopImmediatePropagation(); }, true);
  } catch (error) {
    console.error("[desktop] could not keep the page visible", error);
  }

  // Electron migration (src/migrate.rs): keys the old build kept, written
  // only where nothing newer exists, before the app reads any of them.
  if (cfg.migration) {
    try {
      var marker = cfg.migration.marker;
      if (localStorage.getItem(marker) === null && sessionStorage.getItem(marker) === null) {
        var data = cfg.migration.data;
        for (var key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key) && localStorage.getItem(key) === null) {
            localStorage.setItem(key, data[key]);
          }
        }
        localStorage.setItem(marker, String(Date.now()));
      }
      sessionStorage.setItem(marker, "1");
      internals.invoke("desktop_call", { channel: "migration:done", args: [] }).catch(function () {});
    } catch (error) {
      console.error("[desktop] migrating the Electron build's storage failed", error);
    }
  }

  function call(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    return internals.invoke("desktop_call", { channel: channel, args: args });
  }

  var listeners = Object.create(null);
  function on(channel, listener) {
    var set = listeners[channel] || (listeners[channel] = new Set());
    set.add(listener);
    return function () {
      set.delete(listener);
    };
  }
  // Pushes from the shell (`webview.eval`), the counterpart of
  // `webContents.send`. A push with no listener is dropped, as it was.
  Object.defineProperty(window, "__TYT_DESKTOP__", {
    value: Object.freeze({
      push: function (channel, payload) {
        var set = listeners[channel];
        if (!set) return;
        set.forEach(function (listener) {
          try {
            listener(payload);
          } catch (error) {
            console.error("[desktop] listener for " + channel + " failed", error);
          }
        });
      },
    }),
  });

  function deepFreeze(value) {
    Object.getOwnPropertyNames(value).forEach(function (name) {
      var inner = value[name];
      if (inner && typeof inner === "object") deepFreeze(inner);
    });
    return Object.freeze(value);
  }

  var C = cfg.channels;
  var bridge = {
    isDesktop: true,
    platform: cfg.platform,
    quit: function () {
      return call(C.quit);
    },
    openExternal: function (url) {
      return call(C.openExternal, url);
    },
    getIdleState: function () {
      return call(C.getIdle);
    },
    onIdleState: function (listener) {
      return on(C.idleState, listener);
    },
    secureStore: {
      getToken: function () {
        return call(C.tokenGet);
      },
      setToken: function (token) {
        return call(C.tokenSet, token);
      },
      deleteToken: function () {
        return call(C.tokenDelete);
      },
      status: function () {
        return call(C.tokenStatus);
      },
    },
    desktop: {
      window: {
        getState: function () {
          return call(C.windowGet);
        },
        setMode: function (mode) {
          return call(C.windowMode, mode);
        },
        setAlwaysOnTop: function (enabled) {
          return call(C.windowPin, enabled);
        },
        onChanged: function (listener) {
          return on(C.windowChanged, listener);
        },
      },
      publishTimerState: function (state) {
        return call(C.desktopPublishState, state);
      },
      onCommand: function (listener) {
        return on(C.desktopCommand, listener);
      },
      getSettings: function () {
        return call(C.desktopSettingsGet);
      },
      updateSettings: function (patch) {
        return call(C.desktopSettingsUpdate, patch);
      },
      onSettingsChanged: function (listener) {
        return on(C.desktopSettingsChanged, listener);
      },
      suspendShortcuts: function (suspended) {
        return call(C.desktopSuspendShortcuts, suspended);
      },
      showWindow: function () {
        return call(C.desktopShowWindow);
      },
      notify: function (notice) {
        return call(C.desktopNotify, notice);
      },
      updates: {
        getStatus: function () {
          return call(C.updateGetStatus);
        },
        onStatus: function (listener) {
          return on(C.updateStatusChanged, listener);
        },
        check: function () {
          return call(C.updateCheck);
        },
        restart: function () {
          return call(C.updateRestart);
        },
      },
    },
    // Suggestions are composed in the shell; no raw segment reaches the page.
    activity: {
      protect: function (input) {
        return call(C.activityProtect, input);
      },
      lock: function () {
        return call(C.activityLock);
      },
      snapshot: function () {
        return call(C.activitySnapshot);
      },
      onChanged: function (listener) {
        return on(C.activityChanged, listener);
      },
      updateSettings: function (patch) {
        return call(C.activitySettings, patch);
      },
      setScope: function (scope) {
        return call(C.activityScope, scope);
      },
      forget: function () {
        return call(C.activityForget);
      },
      wipe: function () {
        return call(C.activityWipe);
      },
      suggestions: function (input) {
        return call(C.activitySuggestions, input);
      },
      checkAccept: function (input) {
        return call(C.activityCheckAccept, input);
      },
      markAccepted: function (span) {
        return call(C.activityAccepted, span);
      },
      dismiss: function (span) {
        return call(C.activityDismiss, span);
      },
      addRule: function (rule) {
        return call(C.activityRuleAdd, rule);
      },
      removeRule: function (id) {
        return call(C.activityRuleRemove, id);
      },
      autopilot: {
        learn: function (history) {
          return call(C.activityAutopilotLearn, history);
        },
        plan: function (input) {
          return call(C.activityAutopilotPlan, input);
        },
        applied: function (result) {
          return call(C.activityAutopilotApplied, result);
        },
        hold: function (input) {
          return call(C.activityAutopilotHold, input);
        },
        pause: function (input) {
          return call(C.activityAutopilotPause, input);
        },
      },
    },
  };

  Object.defineProperty(window, "electronAPI", { value: deepFreeze(bridge), writable: false, configurable: false });

  // Window dragging. The macOS window has no title bar, so the app header
  // (`[data-window-drag]`) is what the person drags; on a screen without one
  // (sign-in, 404) a 2.5rem strip across the top does it. Controls inside
  // stay clickable, and nothing drags while a modal holds the page (Radix
  // marks <body> with `data-scroll-locked`). Electron built this from
  // `-webkit-app-region` CSS, which no system WebView reads.
  var INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=button],[role=combobox],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=link],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
  function dragRegion(event) {
    if (event.button !== 0 || !document.body || document.body.hasAttribute("data-scroll-locked")) return false;
    var target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(INTERACTIVE)) return false;
    if (target.closest("[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]")) return false;
    if (target.closest("[data-window-drag]")) return true;
    return cfg.platform === "darwin" && !document.querySelector("[data-window-drag]") && event.clientY <= 40;
  }
  document.addEventListener("mousedown", function (event) {
    if (!dragRegion(event)) return;
    if (event.detail === 2) {
      internals.invoke("plugin:window|internal_toggle_maximize", { label: "main" }).catch(function () {});
    } else {
      internals.invoke("plugin:window|start_dragging", { label: "main" }).catch(function () {});
    }
  });

})(__TYT_CONFIG__);
