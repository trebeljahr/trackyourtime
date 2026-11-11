// e2e builds only: the page half of e2e/desktop/driver.ts. A locator is a
// list of steps the driver sends with every query, resolved here against
// the live DOM, so there is never a stale element handle.
(function () {
  "use strict";
  if (window !== window.top || window.__TYT_E2E__) return;

  // Offline emulation, Playwright's context().setOffline: network requests
  // leave the page as a transport failure while it is on. The app's own
  // origin and Tauri's IPC transport are never cut, or the bridge would go.
  var OFFLINE_KEY = "__tyt_e2e_offline";
  var offline = sessionStorage.getItem(OFFLINE_KEY) === "1";
  var sockets = [];
  function cut(url) {
    try {
      var u = new URL(url, location.href);
      return offline && /^(https?|wss?):$/.test(u.protocol) && u.host !== "ipc.localhost" && u.host !== "app.localhost";
    } catch (e) {
      return false;
    }
  }
  // Requests the harness blocks, Electron's webRequest `cancel: true`: each
  // pattern is a URL with `*` wildcards, and a match fails as a network
  // error before it leaves. Kept per tab, like the offline switch.
  var BLOCK_KEY = "__tyt_e2e_block";
  var blocked = [];
  try {
    blocked = JSON.parse(sessionStorage.getItem(BLOCK_KEY) || "[]");
  } catch (e) {
    blocked = [];
  }
  function globToRegExp(glob) {
    return new RegExp("^" + glob.split("*").map(function (part) { return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join(".*") + "$");
  }
  function isBlocked(url) {
    if (!url || blocked.length === 0) return false;
    var absolute;
    try {
      absolute = new URL(url, location.href).toString();
    } catch (e) {
      return false;
    }
    return blocked.some(function (glob) { return globToRegExp(glob).test(absolute); });
  }
  function block(patterns) {
    blocked = (patterns || []).slice();
    sessionStorage.setItem(BLOCK_KEY, JSON.stringify(blocked));
  }

  // Window moves the bridge asks for (bridge.js, on mousedown in a drag
  // region) are recorded, not performed: a harness click is a DOM event, not
  // the OS mouse press AppKit would drag the window with. Tauri sends every
  // command as a fetch to its IPC protocol (ipc://localhost/<command> on
  // macOS and Linux, http://ipc.localhost/<command> on Windows).
  var WINDOW_MOVES = ["plugin:window|start_dragging", "plugin:window|internal_toggle_maximize"];
  var windowRequests = [];
  function ipcCommand(url) {
    var match = /^(?:ipc:\/\/localhost|https?:\/\/ipc\.localhost)\/([^?#]+)/.exec(url || "");
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return null;
    }
  }

  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var command = ipcCommand(url);
    if (command !== null && WINDOW_MOVES.indexOf(command) !== -1) {
      windowRequests.push(command);
      return Promise.resolve(new Response("null", { status: 200, headers: { "Tauri-Response": "ok", "Content-Type": "application/json" } }));
    }
    if (cut(url) || isBlocked(url)) return Promise.reject(new TypeError("Failed to fetch"));
    return realFetch.apply(this, arguments);
  };
  var RealWebSocket = window.WebSocket;
  function E2EWebSocket(url, protocols) {
    var socket = protocols === undefined ? new RealWebSocket(url) : new RealWebSocket(url, protocols);
    if (cut(url)) setTimeout(function () { socket.close(); }, 0);
    sockets.push(socket);
    return socket;
  }
  E2EWebSocket.prototype = RealWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { E2EWebSocket[k] = RealWebSocket[k]; });
  window.WebSocket = E2EWebSocket;
  Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: function () { return !offline; } });
  function setOffline(value) {
    offline = !!value;
    sessionStorage.setItem(OFFLINE_KEY, offline ? "1" : "0");
    if (offline) sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
    window.dispatchEvent(new Event(offline ? "offline" : "online"));
  }

  function textOf(el) {
    return (el.innerText !== undefined ? el.innerText : el.textContent) || "";
  }
  function norm(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }
  function matches(text, pattern) {
    if (pattern && pattern.regex !== undefined) return new RegExp(pattern.regex, pattern.flags).test(text);
    return norm(text).toLowerCase().indexOf(norm(pattern).toLowerCase()) !== -1;
  }
  function exactly(text, pattern, exact) {
    if (pattern && pattern.regex !== undefined) return new RegExp(pattern.regex, pattern.flags).test(text);
    return exact ? norm(text) === norm(pattern) : matches(text, pattern);
  }
  var IMPLICIT = {
    button: "button,input[type=button],input[type=submit],input[type=reset],[role=button]",
    link: "a[href],[role=link]",
    checkbox: "input[type=checkbox],[role=checkbox]",
    radio: "input[type=radio],[role=radio]",
    textbox: "input:not([type]),input[type=text],input[type=email],input[type=password],input[type=search],input[type=url],input[type=tel],textarea,[role=textbox]",
    heading: "h1,h2,h3,h4,h5,h6,[role=heading]",
    dialog: "dialog,[role=dialog],[role=alertdialog]",
    alertdialog: "[role=alertdialog]",
    combobox: "select,[role=combobox]",
    option: "option,[role=option]",
    menuitem: "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]",
    tab: "[role=tab]",
    switch: "[role=switch]",
    listitem: "li,[role=listitem]",
    navigation: "nav,[role=navigation]",
    status: "[role=status],output",
    alert: "[role=alert]",
    img: "img[alt],[role=img]",
  };
  function accessibleName(el) {
    var label = el.getAttribute("aria-label");
    if (label) return label;
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      return by.split(/\s+/).map(function (id) {
        var ref = document.getElementById(id);
        return ref ? textOf(ref) : "";
      }).join(" ");
    }
    if (el.labels && el.labels.length) return textOf(el.labels[0]);
    if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button")) return el.value;
    if (el.tagName === "IMG") return el.alt || "";
    return textOf(el) || el.getAttribute("title") || "";
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    var style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function find(root, step) {
    if (step.kind === "css") return root.querySelectorAll(step.selector);
    if (step.kind === "testid") return root.querySelectorAll('[data-testid="' + CSS.escape(step.id) + '"]');
    if (step.kind === "role") {
      return Array.prototype.filter.call(root.querySelectorAll(IMPLICIT[step.role] || '[role="' + step.role + '"]'), function (el) {
        return step.name === undefined || exactly(accessibleName(el), step.name, step.exact);
      });
    }
    if (step.kind === "text") {
      return Array.prototype.filter.call(root.querySelectorAll("*"), function (el) {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || !exactly(textOf(el), step.text, step.exact)) return false;
        // The innermost element that matches, as Playwright picks it.
        return !Array.prototype.some.call(el.children, function (child) {
          return exactly(textOf(child), step.text, step.exact);
        });
      });
    }
    if (step.kind === "label") {
      return Array.prototype.filter.call(root.querySelectorAll("input,textarea,select,button,[aria-label],[aria-labelledby]"), function (el) {
        return exactly(accessibleName(el), step.text, step.exact);
      });
    }
    throw new Error("unknown locator step " + step.kind);
  }

  /** Resolve a step list from `roots` (the document, or one element for `has`). */
  function resolve(steps, roots) {
    var current = roots || [document];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (step.kind === "nth") {
        var index = step.index < 0 ? current.length + step.index : step.index;
        current = current[index] ? [current[index]] : [];
        continue;
      }
      if (step.kind === "filter") {
        current = current.filter(function (el) {
          if (step.hasText !== undefined && !matches(textOf(el), step.hasText)) return false;
          if (step.hasNotText !== undefined && matches(textOf(el), step.hasNotText)) return false;
          if (step.has && resolve(step.has, [el]).length === 0) return false;
          if (step.hasNot && resolve(step.hasNot, [el]).length > 0) return false;
          if (step.visible !== undefined && visible(el) !== step.visible) return false;
          return true;
        });
        continue;
      }
      var next = [];
      current.forEach(function (root) {
        Array.prototype.forEach.call(find(root, step), function (el) {
          if (next.indexOf(el) === -1) next.push(el);
        });
      });
      current = next;
    }
    return current.filter(function (el) {
      return el !== document;
    });
  }

  function center(el) {
    var rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  function pointer(el, type, init) {
    var PE = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new PE(type, Object.assign({ bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window }, init)));
  }
  function mouse(el, type, init) {
    el.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, init)));
  }
  function click(el, options) {
    el.scrollIntoView({ block: "center", inline: "center" });
    var at = center(el);
    var base = { clientX: at.x, clientY: at.y, button: 0, detail: 1 };
    var modifiers = (options && options.modifiers) || [];
    ["altKey", "ctrlKey", "metaKey", "shiftKey"].forEach(function (key) {
      base[key] = modifiers.indexOf(key.replace("Key", "").replace(/^./, function (c) { return c.toUpperCase(); })) !== -1;
    });
    pointer(el, "pointerover", base);
    pointer(el, "pointerenter", base);
    mouse(el, "mouseover", base);
    pointer(el, "pointerdown", Object.assign({ buttons: 1 }, base));
    mouse(el, "mousedown", Object.assign({ buttons: 1 }, base));
    if (typeof el.focus === "function" && document.activeElement !== el) el.focus({ preventScroll: true });
    pointer(el, "pointerup", base);
    mouse(el, "mouseup", base);
    // A real click: default actions (links, labels, checkboxes, submits) run.
    el.click();
  }
  var nativeSetters = {};
  function setValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var key = proto.constructor.name;
    var setter = nativeSetters[key] || (nativeSetters[key] = Object.getOwnPropertyDescriptor(proto, "value").set);
    setter.call(el, value);
  }
  function fill(el, value) {
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      setValue(el, value);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var KEYS = { Enter: "Enter", Escape: "Escape", Tab: "Tab", ArrowDown: "ArrowDown", ArrowUp: "ArrowUp", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Backspace: "Backspace", Delete: "Delete", Space: " ", Home: "Home", End: "End" };
  function press(el, combo) {
    var parts = combo.split("+");
    var key = parts.pop();
    var mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    parts.forEach(function (m) {
      if (m === "Alt") mods.altKey = true;
      else if (m === "Control") mods.ctrlKey = true;
      else if (m === "Meta") mods.metaKey = true;
      else if (m === "Shift") mods.shiftKey = true;
      else if (m === "ControlOrMeta") mods.metaKey = navigator.platform.indexOf("Mac") === 0, mods.ctrlKey = !mods.metaKey;
    });
    // Playwright takes a key ("k", "Enter") or a code ("KeyK", "Digit1").
    var code = key;
    var name = KEYS[key] || key;
    var letter = /^Key([A-Z])$/.exec(key);
    var digit = /^Digit([0-9])$/.exec(key);
    if (letter) name = mods.shiftKey ? letter[1] : letter[1].toLowerCase();
    else if (digit) name = digit[1];
    else if (key.length === 1) code = /[0-9]/.test(key) ? "Digit" + key : /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key === " " ? "Space" : key;
    var target = el || document.activeElement || document.body;
    var init = Object.assign({ key: name, code: code, bubbles: true, cancelable: true, composed: true }, mods);
    var down = target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (down && name.length === 1 && !mods.ctrlKey && !mods.metaKey && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      setValue(target, target.value + name);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, data: name, inputType: "insertText" }));
    }
    // Synthetic key events have no default action; do the ones forms need.
    if (down && name === "Enter" && target instanceof HTMLInputElement && target.form) {
      target.form.requestSubmit();
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function query(steps, action, arg) {
    var all = resolve(steps);
    var el = all[0];
    switch (action) {
      case "count":
        return all.length;
      case "visible":
        return !!el && visible(el);
      case "texts":
        return all.map(textOf);
      case "text":
        return el ? textOf(el) : null;
      case "textContent":
        return el ? el.textContent : null;
      case "attribute":
        return el ? el.getAttribute(arg) : null;
      case "value":
        return el ? el.value : null;
      case "enabled":
        return !!el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
      case "checked":
        return !!el && (el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked");
      case "focused":
        return !!el && document.activeElement === el;
      case "describe":
        return all.length + " element(s)" + (el ? ": <" + el.tagName.toLowerCase() + ">" : "");
    }
    if (all.length === 0) throw new Error("no element matches the locator");
    if (all.length > 1 && !(arg && arg.allowMany)) throw new Error("strict mode violation: the locator matches " + all.length + " elements");
    switch (action) {
      case "click":
        if (!visible(el)) throw new Error("element is not visible");
        if (el.disabled) throw new Error("element is disabled");
        click(el, arg);
        return null;
      case "fill":
        fill(el, arg.value);
        return null;
      case "press":
        el.focus();
        press(el, arg.key);
        return null;
      case "check":
        if (!(el.checked === true || el.getAttribute("aria-checked") === "true")) click(el);
        return null;
      case "uncheck":
        if (el.checked === true || el.getAttribute("aria-checked") === "true") click(el);
        return null;
      case "focus":
        el.focus();
        return null;
      case "hover":
        mouse(el, "mouseover", center(el));
        pointer(el, "pointerover", center(el));
        return null;
      case "selectOption":
        setValue(el, arg.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return null;
      case "scroll":
        el.scrollIntoView({ block: "center" });
        return null;
      case "rect":
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    throw new Error("unknown locator action " + action);
  }

  // `withElement` takes the function itself (the driver writes its source
  // into the evaluated script): the page's CSP refuses eval and new Function.
  function withElement(steps, fn, arg) {
    var all = resolve(steps);
    if (all.length === 0) throw new Error("no element matches the locator");
    return fn(all[0], arg);
  }
  function withElements(steps, fn, arg) {
    return fn(resolve(steps), arg);
  }

  Object.defineProperty(window, "__TYT_E2E__", {
    value: Object.freeze({
      query: query,
      withElement: withElement,
      withElements: withElements,
      setOffline: setOffline,
      block: block,
      windowRequests: function () { return windowRequests.slice(); },
      press: function (key) { press(null, key); },
    }),
  });
})();
