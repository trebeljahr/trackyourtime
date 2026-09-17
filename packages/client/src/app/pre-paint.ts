/**
 * The two scripts `app/layout.tsx` inlines into <head>, and the reason they
 * are here rather than inline in that file: a layout module may only export
 * what Next recognises, so a constant declared there cannot be reached by a
 * test. Both of these run before the first paint and neither is imported by
 * anything else at runtime.
 */

/**
 * Runs before first paint so the theme class is on <html> ahead of any
 * styled content — without it, a dark-mode user sees a white flash on
 * every hard navigation. Keep the storage key in sync with
 * `THEME_STORAGE_KEY` in components/theme-toggle.tsx.
 *
 * Its `classList.remove("light", "dark")` is deliberately narrow: it must not
 * disturb the `cap` class the script below may already have added, and the
 * two are order-independent because of it.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem("trackyourtime.theme");if(c!=="light"&&c!=="dark")c=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(c);r.style.colorScheme=c;}catch(e){}})();`;

/**
 * Marks the document as running inside the native shell, before the first
 * paint of anything.
 *
 * `mobile/bridge.ts` sets the same two things, but only after
 * `Promise.all([import("@capacitor/core"), …])` has resolved — several frames
 * into the launch, and after React has already painted. Every rule in
 * styles/native.css keys off `html.cap`, so without this the app lays out once
 * with the header under the Dynamic Island and the composer under the home
 * indicator, then jumps. The bridge's own writes stay: they are idempotent,
 * and they are the recovery path if React ever did clobber the className
 * while hydrating.
 *
 * IT MARKS <html>, NOT <body>, and that is the whole reason it can live in
 * <head>. A script that mutates <body> before hydration makes <body>'s
 * attributes disagree with the server HTML, which React reports as a
 * mismatch — and the only way to silence that is `suppressHydrationWarning` on
 * <body>, which then silences every OTHER body-level mismatch for the web app
 * as well, permanently. <html> already carries that attribute for the theme
 * script, whose class write has exactly the same shape, so folding the second
 * marker onto the same element costs nothing and hands <body> its warnings
 * back.
 *
 * `document.documentElement` exists while <head> is being parsed, so this can
 * run there — earlier than a <body> script could. Capacitor's native bridge is
 * injected as a document-start WKUserScript, so `window.Capacitor` is already
 * there — the same assumption `isCapacitor()` in lib/shell.ts makes.
 */
export const NATIVE_SHELL_SCRIPT = `(function(){try{var c=window.Capacitor;if(!c||!c.isNativePlatform||!c.isNativePlatform())return;var r=document.documentElement;r.classList.add("cap");r.setAttribute("data-platform",c.getPlatform?c.getPlatform():"unknown");}catch(e){}})();`;

/**
 * Marks the document as running inside the Electron shell, before first paint.
 *
 * `html.electron` plus `data-platform` ("darwin" | "win32" | "linux") are what
 * styles/desktop.css keys the window chrome off: the header as the window's
 * drag region, and on macOS the inset that keeps content clear of the traffic
 * lights, which sit inside the page because the window has no title bar. Set
 * this late and the first frame paints the header under the traffic lights and
 * then jumps.
 *
 * `window.electronAPI` is readable here: the preload runs before any page
 * script, head scripts included. Same <html>-not-<body> argument as
 * NATIVE_SHELL_SCRIPT. Deliberately separate from `html.cap`, which means
 * "phone": a desktop window must get none of native.css.
 */
export const DESKTOP_SHELL_SCRIPT = `(function(){try{var e=window.electronAPI;if(!e||e.isDesktop!==true)return;var r=document.documentElement;r.classList.add("electron");if(typeof e.platform==="string")r.setAttribute("data-platform",e.platform);}catch(e){}})();`;

/**
 * Decides the interface language before first paint, and hides the app until
 * React has rendered in it.
 *
 * Every HTML file outside /de/ is prerendered in English, and it has to be:
 * hydration must match the served DOM, so React's first render is English too
 * (`useLocale` answers "en" during hydration by construction). A German reader
 * would therefore see an English page for as long as the JS takes to load —
 * a flash of the wrong language on every hard navigation, and on every cold
 * launch of the Capacitor apps, which load this same export.
 *
 * So this script resolves the language exactly the way `i18n/locale-store.ts`
 * does — stored preference ("en" | "de" | "system"), else the first supported
 * `navigator.languages` entry, else English; in development `?locale=pseudo`
 * and its stored override — writes `lang` and `data-locale` onto <html>, and,
 * when the answer is not English, sets `data-locale-pending`. globals.css
 * hides `[data-locale-gate]` (the app subtree in app/layout.tsx) while that
 * attribute is present, and <LocaleRoot> removes it in a layout effect once
 * the switch has committed — before the browser paints the next frame.
 *
 * Three failure modes this is shaped around:
 *
 *  - It hides the GATE, not <body>. The public pages are prerendered per
 *    language and never switch, so they opt back in with `[data-locale-fixed]`
 *    (visibility is inherited and a descendant may set it back to visible) and
 *    a German visitor to the English landing page is not held on a blank
 *    screen waiting for JavaScript it does not need.
 *  - A 4-second failsafe removes the attribute on its own. If the bundle never
 *    loads — an extension blocking a chunk, a broken deploy — an English page
 *    is a far better failure than an invisible one.
 *  - It writes only to <html>, which already carries
 *    `suppressHydrationWarning`, for the reason given on NATIVE_SHELL_SCRIPT.
 *
 * Built by a function because the pseudo-locale must not exist in production:
 * app/layout.tsx passes `process.env.NODE_ENV !== "production"`, and the
 * production script contains no trace of it. Keep every key and rule here in
 * lockstep with i18n/config.ts and i18n/locale-store.ts; pre-paint.test.ts runs
 * both against the same inputs.
 */
export const localeScript = (allowPseudo: boolean): string =>
  `(function(){try{var r=document.documentElement,l="en",s=null;` +
  `if(/^\\/de(\\/|$)/.test(location.pathname)){r.lang="de";r.setAttribute("data-locale","de");return;}` +
  `try{s=localStorage.getItem("trackyourtime.locale");}catch(e){}` +
  (allowPseudo
    ? `var q=null,o=null;try{q=new URLSearchParams(location.search).get("locale");o=localStorage.getItem("trackyourtime.locale.override");}catch(e){}` +
      `if(q==="pseudo"||(q!=="off"&&o==="pseudo")){l="pseudo";}else `
    : ``) +
  `if(s==="en"||s==="de"){l=s;}else{var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];` +
  `for(var i=0;i<n.length;i++){var p=String(n[i]).trim().toLowerCase().split(/[-_;]/)[0];if(p==="en"||p==="de"){l=p;break;}}}` +
  (allowPseudo ? `r.lang=l==="pseudo"?"en-XA":l;` : `r.lang=l;`) +
  `r.setAttribute("data-locale",l);` +
  `if(l!=="en"){r.setAttribute("data-locale-pending","");setTimeout(function(){r.removeAttribute("data-locale-pending");},4000);}` +
  `}catch(e){}})();`;

/** The script app/layout.tsx inlines, for the build it is part of. */
export const LOCALE_SCRIPT = localeScript(process.env.NODE_ENV !== "production");
