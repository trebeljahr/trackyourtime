// Runs before every other script, in every frame. The app never asks for a
// location, and the system WebView must not ask for one on its behalf: WKWebView
// has no permission answer for geolocation in this embedder and would leave a
// request pending. Without the API there is no request at all (the reason the
// app moved off Electron was Location Services listing it).
(function () {
  "use strict";
  try {
    Object.defineProperty(Navigator.prototype, "geolocation", { configurable: true, enumerable: true, get: function () { return undefined; } });
  } catch (error) {
    /* a frozen prototype: nothing to remove */
  }
})();
