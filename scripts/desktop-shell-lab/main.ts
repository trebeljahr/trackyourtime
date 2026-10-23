import { FALLBACK_TRAY_LABELS, trayMenuModel, trayTitle, trayTooltip, trayClock, elapsedSecAt } from "../../electron/src/tray-model.ts";
import { desktopWindowPolicy } from "../../electron/src/window-policy.ts";
import type { DesktopSettings, DesktopTimerState } from "../../packages/shared/src/desktop-bridge.ts";

declare const __DEFAULT_SETTINGS__: Record<string, DesktopSettings>;
const get = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const select = get<HTMLSelectElement>("platform");
const stateSelect = get<HTMLSelectElement>("state");
const tray = get<HTMLInputElement>("tray");
const background = get<HTMLInputElement>("background");
const offline = get<HTMLInputElement>("offline");
const menu = get("native-menu");
const windowView = get("timer-window");
let startedAt = new Date(Date.now() - 25 * 60_000 - 18_000).toISOString();
let task = "Build the desktop timer";
let open = true;
let menuOpen = false;
let pausedUntil: number | null = null;
const profiles: Record<string, { name: string; behavior: string; limits: string }> = {
  win32: { name: "Windows 11", behavior: "Left-click opens the app; right-click opens the tray menu. Running timer changes the icon. Hover carries elapsed time.", limits: "The user controls tray overflow. A taskbar shortcut restores the app. A live timer beside the tray icon is unavailable through Electron." },
  kde: { name: "KDE Plasma", behavior: "StatusNotifierItem supplies the panel menu. The desktop owns its rendering and activation gesture. Try the menu actions here.", limits: "Keep close-to-tray opt-in. Validate native Wayland shortcuts through the portal. Panel placement and tooltip behavior vary." },
  gnome: { name: "GNOME · no extension", behavior: "No tray is assumed. Launch the app normally; the compact timer is the proposed small working surface.", limits: "Closing exits by default. Relaunch restores access; this sketch is not a background-process test. No extension required for manual timing." },
  ubuntu: { name: "GNOME · AppIndicator enabled", behavior: "The extension hosts the same menu actions. No custom widgets or editable timer inside the native menu.", limits: "Do not infer tray visibility from the distro name. The extension may be disabled. Close-to-tray stays opt-in on Linux." },
  xfce: { name: "Xfce / Cinnamon · indicator host", behavior: "With an indicator host configured, use the shared tray menu. Start, Stop and Continue keep the same meaning.", limits: "Test each panel plugin and display scale. This sketch assumes a host exists; it does not detect an installed desktop." },
  darwin: { name: "macOS", behavior: "Menu-bar title shows elapsed time. Click opens the native menu; Start opens the composer in the app.", limits: "The Dock restores a closed window. This comparison models the Electron app, not the separate Raycast extension." },
};
const platform = () => ["win32", "darwin"].includes(select.value) ? select.value : "linux";
const hasTray = () => tray.checked && select.value !== "gnome";
const settings = () => ({ showInTray: tray.checked, closeHides: background.checked });
function state(): DesktopTimerState {
  return { signedIn: stateSelect.value !== "signed-out", running: stateSelect.value === "running"
    ? { description: task, startedAt, projectName: "Website", projectColor: "#53645a" } : null,
    recents: [{ key: "review", label: "Design review", hint: "Website" }, { key: "invoice", label: "Invoice preparation", hint: "Admin" }],
    unsent: offline.checked ? 2 : 0, autopilot: stateSelect.value === "signed-out" ? null : { pausedUntil },
    labels: { ...FALLBACK_TRAY_LABELS, unsent: "2 unsent changes", autopilotPaused: "Autopilot paused" } };
}
function say(message: string) { get("event").textContent = message; }
function start(description: string) {
  task = description; startedAt = new Date().toISOString(); stateSelect.value = "running";
  say(`Started “${description}” in the local study.`); render();
}
function toggle() {
  if (stateSelect.value === "signed-out") { open = true; say("Sign in is required in the current app. No sign-in is submitted here."); }
  else if (stateSelect.value === "running") { stateSelect.value = "idle"; say("Timer stopped in the study. No records were sent."); }
  else { start(task); return; }
  render();
}
function menuAction(id: string) {
  menuOpen = false;
  if (id === "stop") toggle();
  else if (id.startsWith("continue:")) start(id.endsWith("review") ? "Design review" : "Invoice preparation");
  else if (id === "quit") { open = false; say("App quit simulated. Relaunch using Open Track Your Time."); }
  else if (id === "autopilot-pause" || id === "autopilot-resume") {
    pausedUntil = id === "autopilot-pause" ? Date.now() + 3_600_000 : null;
    say(pausedUntil ? "Autopilot pause simulated. No activity capture is running." : "Autopilot resume simulated.");
  } else { open = true; say(id === "start" ? "Production opens the timer composer. Compact view shown here as a concept."
    : id === "settings" ? "Production opens Settings. Use the study controls to explore device preferences." : "Window restored."); }
  render();
}
function render() {
  const current = state(); const signedIn = current.signedIn; const running = current.running !== null;
  get("desktop").dataset.shell = select.value;
  get("shell-name").textContent = profiles[select.value].name;
  get("topbar").textContent = select.value === "darwin" ? "Track Your Time     File     Edit     View" : select.value === "win32" ? "Desktop preview" : "Activities                                      Friday, 23 October";
  get("behavior").textContent = profiles[select.value].behavior;
  get("limits").textContent = profiles[select.value].limits;
  windowView.hidden = !open;
  get("timer-status").textContent = !signedIn ? "SIGNED OUT" : running ? "TIMER RUNNING" : "READY WHEN YOU ARE";
  get("task").textContent = signedIn ? task : "Sign in to track time";
  get("clock").textContent = running ? trayClock(elapsedSecAt(startedAt, Date.now())) : "0:00";
  get<HTMLButtonElement>("toggle-timer").disabled = !signedIn;
  get("toggle-timer").textContent = running ? "Stop timer" : signedIn ? "Start timer" : "Sign-in required · preview only";
  get("recent-work").hidden = !signedIn;
  get("sync-state").textContent = offline.checked ? "2 unsent changes · synthetic state" : "Local study · no network requests";
  const trayButton = get<HTMLButtonElement>("tray-button");
  trayButton.hidden = !hasTray();
  trayButton.textContent = `${running ? "◴" : "◷"} ${trayTitle(current, Date.now(), platform())}`;
  trayButton.title = trayTooltip(current, Date.now());
  // macOS comparison anchors its icon to the top bar.
  get("panel").style.top = select.value === "darwin" ? "0" : "";
  get("panel").style.bottom = select.value === "darwin" ? "auto" : "0";
  get<HTMLButtonElement>("show-menu").disabled = !hasTray();
  menu.hidden = !menuOpen || !hasTray();
  menu.replaceChildren();
  for (const item of trayMenuModel(current.signedIn ? current : { ...current, running: null, recents: [] })) {
    const el = document.createElement(item.type === "separator" ? "hr" : item.type === "heading" ? "p" : "button");
    if (item.type !== "separator") el.textContent = item.label;
    if (item.type === "item") { (el as HTMLButtonElement).disabled = !item.enabled; el.addEventListener("click", () => menuAction(item.id)); }
    menu.append(el);
  }
}
function reset() {
  const defaults = __DEFAULT_SETTINGS__[platform()];
  tray.checked = defaults.showInTray; background.checked = defaults.closeHides;
  offline.checked = false; stateSelect.value = "running"; open = true; menuOpen = false; pausedUntil = null;
  task = "Build the desktop timer"; startedAt = new Date(Date.now() - 1_518_000).toISOString();
  say("Defaults loaded from the current app. Compact view remains a concept."); render();
}
select.addEventListener("change", reset);
stateSelect.addEventListener("change", () => { menuOpen = false; render(); });
for (const input of [tray, background, offline]) input.addEventListener("change", () => { if (!hasTray()) menuOpen = false; render(); });
get("reset").addEventListener("click", reset);
get("toggle-timer").addEventListener("click", toggle);
get("shortcut").addEventListener("click", () => { toggle(); say("Shortcut action simulated. OS registration, portal consent and conflicts are not tested here."); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task]")) button.addEventListener("click", () => start(button.dataset.task!));
get("close-window").addEventListener("click", () => {
  open = false; menuOpen = false;
  say(desktopWindowPolicy(platform(), settings()).hideOnClose ? "Window hidden. Recover from the tray or launcher."
    : "App exit simulated. Close-to-tray is off; the app does not rely on an invisible tray."); render();
});
get("login").addEventListener("click", () => {
  open = !desktopWindowPolicy(platform(), settings()).allowHiddenLaunch; menuOpen = false;
  say(open ? "Login launch shows the window. Background launch was not opted into."
    : "Login launch hides the window. Background operation is enabled."); render();
});
for (const id of ["launcher", "quick-view"]) get(id).addEventListener("click", () => { open = true; menuOpen = false; say("Compact view opened. This is a proposed view, not a shipped window."); render(); });
function showMenu() { menuOpen = !menuOpen; render(); }
get("show-menu").addEventListener("click", showMenu);
get("tray-button").addEventListener("click", () => {
  if (platform() === "win32") { open = true; menuOpen = false; say("Windows left-click restores the app window."); render(); }
  else showMenu();
});
get("tray-button").addEventListener("contextmenu", (event) => { event.preventDefault(); showMenu(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { menuOpen = false; render(); } });
reset();
setInterval(() => {
  const current = state();
  if (current.running) get("clock").textContent = trayClock(elapsedSecAt(startedAt, Date.now()));
  get("tray-button").title = trayTooltip(current, Date.now());
  get("tray-button").textContent = `${current.running ? "◴" : "◷"} ${trayTitle(current, Date.now(), platform())}`;
}, 1000);
