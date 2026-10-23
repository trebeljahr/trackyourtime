import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import ts from "typescript";

// The native host is replaced; the shipped command handlers and snapshot loader
// run unchanged. No OS keychain, personal records, network or Raycast preferences.
const host = {};
globalThis.__raycastInteraction = host;
const originalWebSocket = globalThis.WebSocket;
// Real sync client and event routing, with no network or personal sessions.
class Socket {
  constructor() {
    host.sockets.push(this);
  }
  close() {}
  send(event, originId, workspaceId = "work") {
    this.onmessage({ data: JSON.stringify({ type: "tt:sync", event, originId, workspaceId }) });
  }
}
globalThis.WebSocket = Socket;
const source = (file) => new URL(`../src/${file}`, import.meta.url).href;
const mocks = new Map([
  [source("lib/menu-presence.ts"), `export const useMenuPresence=visible=>visible;`],
  [
    "react",
    `const h=globalThis.__raycastInteraction;
    export const useRef=v=>({current:v}); export const useEffect=fn=>h.effects.push(fn);
    export const useState=v=>{ const i=h.stateIndex++; return [i===0 && h.search!==undefined?h.search:(typeof v==='function'?v():v),()=>{}]; };`,
  ],
  [
    "react/jsx-runtime",
    `export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment='Fragment';`,
  ],
  [
    "@raycast/api",
    `const h=globalThis.__raycastInteraction;
    const part=name=>Object.assign(()=>null,{displayName:name});
    const group=(name,parts)=>Object.assign(part(name),Object.fromEntries(parts.map(p=>[p,part(name+'.'+p)])));
    export const Action=group('Action',['Push','SubmitForm','OpenInBrowser','CopyToClipboard']); Action.Style={Destructive:'destructive'};
    export const ActionPanel=group('ActionPanel',['Section','Submenu']);
    export const List=group('List',['Item','Section','EmptyView','Dropdown']); List.Dropdown.Item=part('List.Dropdown.Item');
    export const MenuBarExtra=group('MenuBarExtra',['Item','Section','Submenu']);
    export const Icon=new Proxy({},{get:(_,key)=>String(key)}); export const Color={Green:'green',Orange:'orange',SecondaryText:'secondary',Yellow:'yellow'};
    export const Keyboard={Shortcut:{Common:{New:{key:'n'},Edit:{key:'e'},Save:{key:'s'},Open:{key:'o'},Refresh:{key:'r'},Copy:{key:'c'}}}};
    export const Toast={Style:{Success:'success',Failure:'failure'}}; export const Alert={ActionStyle:{Destructive:'destructive'}};
    export const LaunchType={UserInitiated:'user',Background:'background'};
    export const environment={get launchType(){return h.launchType;}};
    export const updateCommandMetadata=async metadata=>{if(h.metadataFails)throw Error('metadata unavailable');h.events.push(['metadata',metadata]);};
    export const launchCommand=async options=>h.events.push(['launch',options]);
    export const showToast=async options=>h.events.push(['toast',options]); export const showHUD=async text=>h.events.push(['hud',text]);
    export const open=async()=>{}; export const confirmAlert=async()=>true;
    export const getPreferenceValues=()=>({showWhenIdle:h.showWhenIdle});
    export const useNavigation=()=>({push:element=>h.events.push(['push',element]),pop:()=>{}});`,
  ],
  [source("lib/api.ts"), `export const getTrackYourTime=async()=>globalThis.__raycastInteraction.api;`],
  [
    source("lib/hooks.ts"),
    `const h=globalThis.__raycastInteraction;
    export const useApi=()=>({data:h.data,isLoading:false,signedOut:false,revalidate:()=>h.events.push(['refresh']),refresh:async()=>{h.events.push(['refresh']);if(h.revalidate)await h.revalidate();},optimistic:async request=>{const result=await request;h.events.push(['refresh']);if(h.revalidate)await h.revalidate();return result;}});
    export const useReconciledRunning=data=>data?.running??null; export const useNow=()=>h.now;
    export const usePoll=()=>{}; export const useWatchRunning=()=>{};`,
  ],
  [
    source("lib/auth.ts"),
    `export const getStoredUserId=async()=> 'owner'; export const getStoredSession=async()=>({token:'synthetic-token'});`,
  ],
  [
    source("lib/local-cache.ts"),
    `export const loadCache=async()=>globalThis.__raycastInteraction.cache??({settings:null});`,
  ],
  [
    source("lib/storage.ts"),
    `const h=globalThis.__raycastInteraction; export const loadTimerEcho=async()=>null; export const noteTimerEcho=async()=>{}; export const raycastStorage={getItem:async key=>h.statusValues.get(key)??null,setItem:async(key,value)=>h.statusValues.set(key,value),removeItem:async key=>h.statusValues.delete(key)};`,
  ],
  [
    source("lib/workspace.ts"),
    `const h=globalThis.__raycastInteraction;
    export const activeWorkspaceId=async()=>h.workspace;
    export const workspaceNameLookup=async()=>id=>h.data.workspaces.find(w=>w.id===id)?.name??null;
    export const chooseWorkspace=async id=>{h.workspace=id;return true;};`,
  ],
  [
    source("lib/offline.ts"),
    `export const pendingCounts=async()=>({mine:0,foreign:0,left:0,held:0,heldReason:null});
    export const discardForeign=async()=>0; export const listForeign=async()=>[]; export const heldCopy=()=>({title:'Waiting'});`,
  ],
  [source("lib/overlay.ts"), `export const isLocalEntry=entry=>entry.id.startsWith("temp-");`],
  [
    source("lib/preferences.ts"),
    `export const apiUrl=()=> 'https://synthetic.invalid'; export const hostLabel=()=> 'Synthetic'; export const webLink=p=>'https://synthetic.invalid'+p;`,
  ],
  [source("lib/server-level.ts"), `export const useServerLevel=()=>({banner:null,supports:()=>true});`],
  [
    source("lib/ui.ts"),
    `const h=globalThis.__raycastInteraction;
    export const refreshMenuBar=async()=>h.events.push(['menu-refresh']);
    export const showFailureToast=async error=>h.events.push(['failure',error.message]);
    export const isAlreadyStopped=()=>false; export const replacedNotice=entry=>entry.replaced?'Stopped your timer in '+entry.replaced.workspaceName:undefined; export const describeFailure=String;`,
  ],
]);
for (const [file, names] of [
  ["compatibility-banner", ["CompatibilityListSection", "CompatibilityMenuBarSection"]],
  ["offline-recovery", ["OfflineRecovery"]],
  ["edit-entry", ["EditEntry"]],
  ["log-time", ["LogTime"]],
  ["signed-out", ["SignedOutView"]],
  ["sign-in", ["SignIn"]],
  ["start-timer", ["StartTimer"]],
])
  mocks.set(
    source(`components/${file}.tsx`),
    names.map((name) => `export function ${name}(){return null;}`).join("\n"),
  );
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (mocks.has(specifier)) return { url: `host:${encodeURIComponent(specifier)}`, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(specifier.replace(/\.js$/, extension), context.parentURL).href;
        if (mocks.has(candidate)) return { url: `host:${encodeURIComponent(candidate)}`, shortCircuit: true };
        try {
          readFileSync(fileURLToPath(candidate));
          return { url: candidate, shortCircuit: true };
        } catch {}
      }
    }
    // Relative imports inside a mocked module use the original source URL.
    if (context.parentURL?.startsWith("host:") && specifier.startsWith("."))
      return next(new URL(specifier, decodeURIComponent(context.parentURL.slice(5))).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("host:"))
      return { format: "module", source: mocks.get(decodeURIComponent(url.slice(5))), shortCircuit: true };
    if (/\.tsx?$/.test(url))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          fileName: fileURLToPath(url),
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
after(() => {
  hook.deregister();
  globalThis.WebSocket = originalWebSocket;
  delete globalThis.__raycastInteraction;
});
const { default: Timer } = await import("../src/timer-view.tsx");
const { default: MenuBar } = await import("../src/menu-bar.tsx");
const { default: ToggleTimer } = await import("../src/timer.ts");
const { default: Entries } = await import("../src/entries.tsx");
const { useSyncRevalidate } = await import("../src/lib/sync.ts");
const { formatMenuBarClock } = await import("../src/lib/format.ts");
const { loadTimerSnapshot } = await import("../src/lib/timer-data.ts");
const { markTimerAction, refreshTimerSearch } = await import("../src/lib/timer-search.ts");
const entry = (overrides = {}) => ({
  id: "new-entry",
  workspaceId: "work",
  authorId: "owner",
  description: "Design",
  clientId: null,
  projectId: null,
  taskId: null,
  tagIds: [],
  billable: false,
  start: new Date(Date.now() - 60_000).toISOString(),
  end: null,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: "api",
  timeZone: "Europe/Berlin",
  runaway: null,
  invoiceId: null,
  importId: null,
  createdAt: "",
  updatedAt: "",
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount: 0,
  ...overrides,
});
beforeEach(() => {
  Object.assign(host, {
    events: [],
    revalidate: null,
    effects: [],
    sockets: [],
    stateIndex: 0,
    search: undefined,
    now: Date.now(),
    showWhenIdle: false,
    launchType: "user",
    metadataFails: false,
    cache: { settings: null, projects: [], tasks: [] },
    statusValues: new Map(),
    workspace: "work",
  });
  host.data = {
    running: null,
    recent: [],
    favorites: [],
    projects: [],
    todaySec: 0,
    pending: 0,
    foreign: 0,
    held: 0,
    activeWorkspaceId: "work",
    workspaces: [
      { id: "work", name: "Personal" },
      { id: "other", name: "Studio" },
    ],
  };
  host.api = {
    current: async () => host.data.running,
    sync: async () => {},
    workspaces: async () => host.data.workspaces,
    list: async (input) => {
      host.events.push(["list", input]);
      return { entries: host.data.recent };
    },
    favorites: async () => host.data.favorites,
    projects: async () => host.data.projects,
    start: async (input) => {
      host.events.push(["start", input]);
      return entry({ description: input.description ?? "" });
    },
    stop: async (id) => {
      host.events.push(["stop", id]);
      return entry({ end: new Date().toISOString(), durationSec: 60 });
    },
    startQuick: async (input) => {
      host.events.push(["favorite", input]);
      return entry();
    },
    continue: async (id) => {
      host.events.push(["continue", id]);
      return entry();
    },
  };
});
const walk = (node) =>
  !node || typeof node !== "object"
    ? []
    : Array.isArray(node)
      ? node.flatMap(walk)
      : [node, ...walk(node.props?.children), ...walk(node.props?.actions)];
const nodes = (tree, name) => walk(tree).filter((n) => n.type?.displayName === name);
const render = (Component, props = {}) => {
  host.stateIndex = 0;
  host.effects = [];
  return Component(props);
};
const primary = (row) => nodes(row.props.actions, "Action")[0];

test("first timer row starts now, then edits the started entry", async () => {
  const tree = render(Timer);
  const first = nodes(tree, "List.Item")[0];
  assert.equal(first.props.title, "Start Timer");
  await primary(first).props.onAction();
  assert.deepEqual(
    host.events.filter((e) => e[0] === "start"),
    [["start", { description: "" }]],
  );
  const pushed = host.events.find((e) => e[0] === "push");
  assert.equal(pushed[1].props.entry.id, "new-entry");
  assert.ok(host.events.findIndex((e) => e[0] === "start") < host.events.findIndex((e) => e[0] === "push"));
  assert.ok(nodes(first.props.actions, "Action.Push").some((action) => action.props.title === "Start with Details…"));
});

test("explicit sign-in recovery opens pairing from the Timer command", () => {
  render(Timer, { launchContext: { signIn: true } });
  host.effects.forEach((run) => run());
  assert.equal(host.events.find(([kind]) => kind === "push")[1].type.name, "SignIn");
  assert.equal(
    host.events.some(([kind]) => kind === "start"),
    false,
  );
});

test("immediate starts disclose a timer replaced in another workspace", async () => {
  host.api.start = async () => entry({ replaced: { workspaceName: "Studio" } });
  await primary(nodes(render(Timer), "List.Item")[0]).props.onAction();
  assert.ok(host.events.some(([kind, value]) => kind === "toast" && value.message === "Stopped your timer in Studio"));

  host.events = [];
  host.showWhenIdle = true;
  nodes(render(MenuBar), "MenuBarExtra.Item")
    .find((row) => row.props.title === "Start Timer")
    .props.onAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(host.events.some(([kind, value]) => kind === "toast" && value.message === "Stopped your timer in Studio"));
});
test("project shortcut starts without treating a search query as its description", async () => {
  host.search = "  Review  ";
  host.data.projects = [{ id: "project", name: "Website", clientName: "Acme", color: "#fff", billableDefault: true }];
  const tree = render(Timer);
  const project = nodes(tree, "List.Item").find((n) => n.props.title === "Website");
  await primary(project).props.onAction();
  assert.deepEqual(host.events.find((e) => e[0] === "start")[1], {
    description: "",
    projectId: "project",
    billable: true,
  });
});
test("repeat presses while a start is in flight create one timer", async () => {
  let release;
  host.api.start = async (input) => {
    host.events.push(["start", input]);
    await new Promise((r) => {
      release = r;
    });
    return entry();
  };
  const action = primary(nodes(render(Timer), "List.Item")[0]).props.onAction;
  const first = action();
  await Promise.resolve();
  await action();
  release();
  await first;
  assert.equal(host.events.filter((e) => e[0] === "start").length, 1);
});
test("failed starts do not open an editor and can be retried", async () => {
  host.api.start = async () => {
    throw Error("offline refusal");
  };
  const action = primary(nodes(render(Timer), "List.Item")[0]).props.onAction;
  await action();
  await action();
  assert.equal(host.events.filter((e) => e[0] === "failure").length, 2);
  assert.ok(!host.events.some((e) => e[0] === "push"));
});
test("queued timers run without opening an editor with an unresolved id", async () => {
  host.api.start = async () => entry({ id: "temp-synthetic" });
  await primary(nodes(render(Timer), "List.Item")[0]).props.onAction();
  assert.ok(!host.events.some((e) => e[0] === "push"));
  assert.ok(host.events.some((e) => e[0] === "toast" && e[1].title === "Timer started"));
});
test("menu start creates a timer before handing off to its editor", async () => {
  host.showWhenIdle = true;
  const tree = render(MenuBar);
  const start = nodes(tree, "MenuBarExtra.Item").find((n) => n.props.title === "Start Timer");
  const action = start.props.onAction();
  assert.ok(action instanceof Promise);
  await action;
  const launch = host.events.find((e) => e[0] === "launch");
  assert.equal(launch[1].name, "entries");
  assert.equal(launch[1].context.showTimer, true);
  assert.equal(launch[1].context.editRunningId, "new-entry");
  assert.ok(host.events.findIndex((e) => e[0] === "start") < host.events.findIndex((e) => e[0] === "launch"));
});
test("menu is hidden idle and releases the host after reading a running timer", () => {
  assert.equal(render(MenuBar), null);
  host.data.running = entry({ start: new Date(host.now - 60_000).toISOString() });
  const first = render(MenuBar);
  assert.equal(first.props.title, "1m");
  assert.equal(first.props.icon, "menu-bar.png");
  assert.equal(first.props.isLoading, false);
  host.now += 60_000;
  assert.equal(render(MenuBar).props.title, "2m");
});
test("the running timer name leads a separate summary without project or client context", async () => {
  host.data.running = entry({
    description: "Design review",
    start: new Date(host.now - 60_000).toISOString(),
    projectName: "Website",
    projectColor: "#19a7ce",
    clientName: "Studio",
  });
  const tree = render(MenuBar);
  const rows = nodes(tree, "MenuBarExtra.Item");
  const name = rows[0];
  assert.equal(name.props.title, "Design review");
  assert.equal(name.props.tooltip, "Design review");
  const [summary, controls] = nodes(tree, "MenuBarExtra.Section");
  assert.equal(summary.props.title, undefined);
  assert.deepEqual(nodes(summary, "MenuBarExtra.Item").map((row) => row.props.title), [
    "Design review",
    "Running for 1m",
  ]);
  const timing = rows.find((row) => row.props.title.startsWith("Running for"));
  assert.equal(timing.props.onAction, undefined, "passive timing uses the native dimmed style");
  assert.equal(timing.props.icon, undefined);
  assert.ok(!rows.some((row) => row.props.title.includes("Studio") || row.props.title.includes("Website")));
  assert.equal(nodes(controls, "MenuBarExtra.Item")[0].props.title, "Stop Timer");
  for (const row of [name, rows.find((row) => row.props.title === "Edit Timer…")]) {
    host.events = [];
    await row.props.onAction();
    assert.deepEqual(host.events, [
      ["launch", { name: "entries", type: "user", context: { showTimer: true, editRunningId: "new-entry" } }],
    ]);
  }
});

test("timer names stay on one line and retain empty-description fallbacks", () => {
  for (const [description, projectName, expected] of [
    ["  Review changes\nMore notes  ", null, "Review changes"],
    [" ", "Website", "Website"],
    ["", null, "No description"],
  ]) {
    host.data.running = entry({ description, projectName });
    assert.equal(nodes(render(MenuBar), "MenuBarExtra.Item")[0].props.title, expected);
  }
  host.data.running = entry({ description: "A long work name ".repeat(20) });
  const name = nodes(render(MenuBar), "MenuBarExtra.Item")[0].props.title;
  assert.ok(name.length <= 48);
  assert.ok(name.endsWith("…"));
});

test("starting other work is offered only while idle, and history stays outside the menu", () => {
  host.showWhenIdle = true;
  host.data.recent = [entry({ id: "past" })];
  host.data.favorites = [{ id: "pin", description: "Favorite" }];
  host.data.projects = [{ id: "project", name: "Website", color: "#19a7ce" }];
  host.data.running = entry();
  const running = render(MenuBar);
  const sectionTitles = nodes(running, "MenuBarExtra.Section").map((row) => row.props.title);
  const actionTitles = nodes(running, "MenuBarExtra.Item").map((row) => row.props.title);
  assert.ok(!sectionTitles.includes("Recent Work"));
  assert.ok(!sectionTitles.includes("Quick Start"));
  assert.ok(!sectionTitles.includes("Favorites"));
  assert.ok(!actionTitles.includes("Start Timer"));
  assert.ok(!actionTitles.includes("Timer Details…"));
  assert.ok(!nodes(running, "MenuBarExtra.Submenu").some((row) => row.props.title === "Move to Project"));
  host.data.running = null;
  const idle = render(MenuBar);
  assert.ok(!nodes(idle, "MenuBarExtra.Section").some((row) => row.props.title === "Recent Work"));
  assert.ok(nodes(idle, "MenuBarExtra.Section").some((row) => row.props.title === "Quick Start"));
  assert.ok(nodes(idle, "MenuBarExtra.Item").some((row) => row.props.title === "Favorite"));
  assert.ok(nodes(idle, "MenuBarExtra.Item").some((row) => row.props.title === "Start Timer"));
});

test("menu editor launch never edits an entry from another workspace", () => {
  host.data.running = entry();
  render(Timer, { launchContext: { editRunningId: "new-entry" } });
  host.effects.forEach((fn) => fn());
  assert.equal(host.events.filter((e) => e[0] === "push").length, 1);
  host.events = [];
  host.data.running = entry({ workspaceId: "other" });
  render(Timer, { launchContext: { editRunningId: "new-entry" } });
  host.effects.forEach((fn) => fn());
  assert.equal(host.events.filter((e) => e[0] === "push").length, 0);
});
test("recent work and favorites start from their own row, with workspace visible", async () => {
  host.data.recent = [entry({ id: "past-entry", end: new Date().toISOString() })];
  host.data.favorites = [
    { id: "pin", description: "Pinned work", projectId: null, taskId: null, clientId: null, billable: false },
  ];
  const tree = render(Timer);
  assert.equal(tree.props.searchBarAccessory.props.value, "work");
  const recent = nodes(tree, "List.Section").find((n) => n.props.title === "Recent Work");
  await primary(nodes(recent, "List.Item")[0]).props.onAction();
  assert.ok(host.events.some((e) => e[0] === "continue" && e[1] === "past-entry"));
  const favorite = nodes(tree, "List.Section").find((n) => n.props.title === "Favorites");
  await primary(nodes(favorite, "List.Item")[0]).props.onAction();
  assert.ok(host.events.some((e) => e[0] === "favorite"));
});
test("a first-ever hotkey starts immediately, without a preliminary form", async () => {
  await ToggleTimer();
  assert.ok(host.events.some((e) => e[0] === "start"));
  assert.equal(host.events.find((e) => e[0] === "launch")[1].context.editRunningId, "new-entry");
  assert.equal(host.events.find((e) => e[0] === "launch")[1].name, "entries");
});
test("the manifest exposes one timer toggle and no alternate timer command", () => {
  const { commands } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    commands.some((command) => command.name === "toggle-timer"),
    false,
  );
  const timer = commands.find((command) => command.name === "timer");
  assert.equal(timer.mode, "no-view");
  assert.equal(timer.disabledByDefault, undefined);
  assert.equal(timer.interval, undefined);
  assert.ok(timer.keywords.includes("track your time"));
});
test("history hosts timer details without invoking the toggle", () => {
  const screen = render(Entries, { launchContext: { showTimer: true, editRunningId: "running-entry" } });
  assert.equal(screen.type, Timer);
  assert.equal(screen.props.launchContext.editRunningId, "running-entry");
  assert.deepEqual(host.events, []);
});
test("offline immediate starts never launch an editor for a temporary id", async () => {
  host.api.start = async () => entry({ id: "temp-synthetic" });
  await ToggleTimer();
  assert.ok(!host.events.some(([kind]) => kind === "launch"));
  assert.ok(host.events.some(([kind, value]) => kind === "hud" && value.startsWith("▶ Timer started")));
});
test("the Timer view replaces its first start row with an explicit stop action", async () => {
  const running = entry({ id: "running-entry", description: "Design review", projectName: "Website" });
  host.data.running = running;
  const row = nodes(render(Timer), "List.Item")[0];
  assert.equal(row.props.title, "Stop Timer");
  assert.match(row.props.subtitle, /Design review/);
  assert.match(row.props.subtitle, /Website/);
  assert.ok(row.props.keywords.includes("Design review"));
  assert.equal(primary(row).props.title, "Stop Timer");
  await primary(row).props.onAction();
  assert.deepEqual(
    host.events.find(([kind]) => kind === "stop"),
    ["stop", "running-entry"],
  );
  assert.ok(!host.events.some(([kind]) => kind === "start"));
});
test("background toggle refreshes running and idle labels without tracking or opening UI", async () => {
  host.launchType = "background";
  host.data.running = entry({ description: "Design review" });
  await ToggleTimer();
  assert.match(host.events[0][1].subtitle, /^Stop Timer · Design review · /);
  host.data.running = null;
  await ToggleTimer();
  assert.equal(host.events[1][1].subtitle, "Start Timer · No timer running");
  assert.ok(host.events.every(([kind]) => kind === "metadata"));
});
test("status refresh waits until a foreground timer action finishes", async () => {
  await markTimerAction(true);
  await refreshTimerSearch();
  host.launchType = "background";
  await ToggleTimer();
  assert.deepEqual(host.events, []);
  await markTimerAction(false);
  await refreshTimerSearch();
  assert.deepEqual(host.events, [["launch", { name: "timer", type: "background" }]]);
});
test("search names the task and project of the timer it will stop", async () => {
  host.launchType = "background";
  host.cache.projects = [{ id: "project", name: "Website" }];
  host.cache.tasks = [{ id: "task", name: "Health checks" }];
  host.data.running = entry({ taskId: "task", projectId: "project", description: "Long notes ".repeat(40) });
  await ToggleTimer();
  assert.match(host.events[0][1].subtitle, /^Stop Timer · Health checks · Website · /);
  assert.ok(host.events.every(([kind]) => kind === "metadata"));
});
test("search never labels a timer with another workspace's catalog names", async () => {
  host.launchType = "background";
  host.cache.projects = [{ id: "project", name: "Wrong workspace" }];
  host.cache.tasks = [{ id: "task", name: "Wrong task" }];
  host.data.running = entry({ workspaceId: "other", taskId: "task", projectId: "project", description: "Actual work" });
  await ToggleTimer();
  assert.match(host.events[0][1].subtitle, /^Stop Timer · Actual work · /);
  assert.ok(!host.events[0][1].subtitle.includes("Wrong"));
});
test("a failed background status read clears stale action hints without showing UI", async () => {
  host.launchType = "background";
  host.api.current = async () => {
    throw Error("offline");
  };
  await ToggleTimer();
  assert.deepEqual(host.events, [["metadata", { subtitle: "Timer status unavailable · Open Timer to check" }]]);
});
test("the toggle stops the current entry and switches its search hint back to Start", async () => {
  host.data.running = entry({ id: "running-entry" });
  await ToggleTimer();
  assert.deepEqual(
    host.events.find(([kind]) => kind === "stop"),
    ["stop", "running-entry"],
  );
  assert.equal(host.events.find(([kind]) => kind === "metadata")[1].subtitle, "Start Timer · No timer running");
  assert.ok(!host.events.some(([kind]) => kind === "start" || kind === "continue"));
});
test("metadata failures do not prevent a user from stopping their timer", async () => {
  host.metadataFails = true;
  host.data.running = entry();
  await ToggleTimer();
  assert.ok(host.events.some(([kind]) => kind === "stop"));
  assert.ok(!host.events.some(([kind]) => kind === "failure"));
});
test("current timer is independent of the recent window and stale history", async () => {
  host.data.running = entry({ start: "2026-01-01T00:00:00Z" });
  let snapshot = await loadTimerSnapshot(host.api, { recentLimit: 8 });
  assert.equal(snapshot.running.id, "new-entry");
  const query = host.events.find((e) => e[0] === "list")[1];
  assert.ok(Date.parse(query.from) < Date.now() - 29 * 86400000);
  host.data.recent = [entry({ id: "stale-running" })];
  host.data.running = null;
  snapshot = await loadTimerSnapshot(host.api, { recentLimit: 8 });
  assert.equal(snapshot.running, null);
});
test("recents retain distinct billable work and exclude a colleague's entries", async () => {
  host.data.recent = [
    entry({ id: "billable", end: "2026-10-22T00:00:00Z", billable: true }),
    entry({ id: "unbilled", end: "2026-10-22T00:00:00Z" }),
    entry({ id: "colleague", authorId: "someone-else", end: "2026-10-22T00:00:00Z" }),
  ];
  const snapshot = await loadTimerSnapshot(host.api, { recentLimit: 8 });
  assert.deepEqual(
    snapshot.recent.map((e) => e.id),
    ["billable", "unbilled"],
  );
});

test("the new-work action starts with the description typed in search", async () => {
  host.search = "  Review  ";
  const tree = render(Timer);
  const row = nodes(tree, "List.Item")[0];
  assert.equal(row.props.title, "Start “Review”");
  await primary(row).props.onAction();
  assert.deepEqual(host.events.find((e) => e[0] === "start")[1], { description: "Review" });
});
test("queued status never steals the first start action", () => {
  host.data.pending = 2;
  const tree = render(Timer);
  assert.equal(nodes(tree, "List.Item")[0].props.title, "Start Timer");
  assert.ok(nodes(tree, "List.Section").some((n) => n.props.title === "Not synced"));
});
test("fresh current fields outrank an older history response", async () => {
  host.data.running = entry({ description: "Fresh", projectId: null });
  host.data.recent = [entry({ description: "Old", projectId: "old-project", projectName: "Old Project" })];
  const snapshot = await loadTimerSnapshot(host.api, { recentLimit: 8 });
  assert.equal(snapshot.running.description, "Fresh");
  assert.equal(snapshot.running.projectName, null);
});

test("menu actions wait for the snapshot and request a fresh native item before opening details", async () => {
  host.showWhenIdle = true;
  let finish;
  host.revalidate = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const start = nodes(render(MenuBar), "MenuBarExtra.Item").find((n) => n.props.title === "Start Timer");
  const action = start.props.onAction();
  await new Promise(setImmediate);
  assert.ok(!host.events.some(([kind]) => kind === "menu-refresh" || kind === "launch"));
  finish();
  await action;
  const refresh = host.events.findIndex(([kind]) => kind === "menu-refresh");
  const editor = host.events.findIndex(([kind]) => kind === "launch");
  assert.ok(refresh >= 0 && refresh < editor);
});

test("every timer mutation from the menu refreshes its native item after settling", async () => {
  host.showWhenIdle = true;
  host.data.running = entry();
  host.data.recent = [entry({ id: "past", end: new Date().toISOString() })];
  host.data.favorites = [
    { id: "pin", description: "Favorite", projectId: null, taskId: null, clientId: null, billable: false },
  ];
  host.api.discard = async () => {};
  host.api.addFavorite = async () => {};
  const tree = render(MenuBar);
  for (const title of ["Stop Timer", "Discard Timer", "Pin as Favorite"]) {
    host.events = [];
    const row = nodes(tree, "MenuBarExtra.Item").find((n) => n.props.title === title);
    const action = row.props.onAction();
    assert.ok(action instanceof Promise, title);
    await action;
    assert.ok(
      host.events.some(([kind]) => kind === "refresh"),
      title,
    );
    assert.ok(
      host.events.some(([kind]) => kind === "menu-refresh"),
      title,
    );
  }
  host.data.running = null;
  host.events = [];
  const favorite = nodes(render(MenuBar), "MenuBarExtra.Item").find((row) => row.props.title === "Favorite");
  await favorite.props.onAction();
  assert.ok(host.events.some(([kind]) => kind === "menu-refresh"));
});

test("an offline menu start refreshes without opening an editor for a temporary id", async () => {
  host.showWhenIdle = true;
  host.api.start = async () => entry({ id: "temp-offline" });
  const row = nodes(render(MenuBar), "MenuBarExtra.Item").find((n) => n.props.title === "Start Timer");
  await row.props.onAction();
  assert.ok(host.events.some(([kind]) => kind === "menu-refresh"));
  assert.ok(!host.events.some(([kind]) => kind === "launch"));
});

test("scheduled launches refresh hidden timers without needing an open command", () => {
  const { commands } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(commands.find((command) => command.name === "menu-bar").interval, "10s");
});

test("a newly loaded menu adopts starts, replacements and stops from other clients", async () => {
  // Persisted history deliberately lags: current() must decide what runs.
  host.data.recent = [entry({ id: "old-timer" })];
  let remote = null;
  host.api.current = async () => remote;
  for (const source of ["web", "chrome", "desktop"]) {
    remote = entry({ id: source + "-timer", description: source });
    host.data = await loadTimerSnapshot(host.api, { recentLimit: 6 });
    assert.match(render(MenuBar).props.tooltip, new RegExp(source));
    remote = null;
    host.data = await loadTimerSnapshot(host.api, { recentLimit: 6 });
    assert.equal(render(MenuBar), null);
  }
});

test("menu clock labels keep minute precision across hour boundaries", () => {
  for (const [seconds, label] of [
    [-1, "<1m"],
    [0, "<1m"],
    [59, "<1m"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h 00m"],
    [3720, "1h 02m"],
  ]) {
    assert.equal(formatMenuBarClock(seconds), label);
  }
});

test("a loaded menu receives timer events from the web, Chrome, desktop and other Raycast commands", async () => {
  let reads = 0;
  useSyncRevalidate(() => {
    reads++;
  }, true);
  const cleanups = host.effects.map((effect) => effect());
  await new Promise(setImmediate);
  const [socket] = host.sockets;
  assert.ok(socket);
  socket.onopen();
  assert.equal(reads, 1); // Catch up after reconnect, including missed events.
  for (const origin of ["web", "chrome", "desktop", "same-raycast-install"]) {
    socket.send({ kind: "timer.started", entry: entry() }, origin);
    socket.send({ kind: "timer.stopped", entry: entry({ end: new Date().toISOString() }) }, origin);
  }
  // Timers follow the person even when another workspace is on screen.
  socket.send({ kind: "timer.started", entry: entry({ workspaceId: "other" }) }, "desktop", "other");
  await new Promise(setImmediate);
  assert.equal(reads, 10);
  cleanups.forEach((cleanup) => cleanup?.());
  socket.send({ kind: "timer.stopped", entry: entry() }, "web");
  await new Promise(setImmediate);
  assert.equal(reads, 10); // The next scheduled launch owns unloaded state.
});
