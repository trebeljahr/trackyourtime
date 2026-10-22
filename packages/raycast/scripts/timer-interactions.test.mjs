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
const source = (file) => new URL(`../src/${file}`, import.meta.url).href;
const mocks = new Map([
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
    export const useApi=()=>({data:h.data,isLoading:false,signedOut:false,revalidate:()=>h.events.push(['refresh']),optimistic:request=>request});
    export const useReconciledRunning=data=>data?.running??null; export const useNow=()=>h.now;
    export const usePoll=()=>{}; export const useWatchRunning=()=>{};`,
  ],
  [source("lib/auth.ts"), `export const getStoredUserId=async()=> 'owner';`],
  [source("lib/local-cache.ts"), `export const loadCache=async()=>({settings:null});`],
  [source("lib/storage.ts"), `export const loadTimerEcho=async()=>null; export const noteTimerEcho=async()=>{};`],
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
  [source("lib/sync.ts"), `export const useSyncRevalidate=()=>true;`],
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
  delete globalThis.__raycastInteraction;
});
const { default: Timer } = await import("../src/timer.tsx");
const { default: MenuBar } = await import("../src/menu-bar.tsx");
const { default: ToggleTimer } = await import("../src/toggle-timer.ts");
const { loadTimerSnapshot } = await import("../src/lib/timer-data.ts");
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
    effects: [],
    stateIndex: 0,
    search: undefined,
    now: Date.now(),
    showWhenIdle: false,
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
  start.props.onAction();
  await new Promise(setImmediate);
  const launch = host.events.find((e) => e[0] === "launch");
  assert.equal(launch[1].context.editRunningId, "new-entry");
  assert.ok(host.events.findIndex((e) => e[0] === "start") < host.events.findIndex((e) => e[0] === "launch"));
});
test("menu is hidden idle and displays only a moving clock while tracking", () => {
  assert.equal(render(MenuBar), null);
  host.data.running = entry({ start: new Date(host.now - 60_000).toISOString() });
  const first = render(MenuBar);
  assert.equal(first.props.title, "1:00");
  assert.equal(first.props.icon, undefined);
  assert.equal(first.props.isLoading, true);
  host.now += 1000;
  assert.equal(render(MenuBar).props.title, "1:01");
});
test("menu recents show a task name while continuing the complete original entry", async () => {
  host.showWhenIdle = true;
  const past = entry({
    id: "past-entry",
    taskId: "task",
    taskName: "Health checks",
    projectId: "project",
    projectName: "Website",
    clientName: "Studio",
    description:
      "Investigate the restart loop; review logs and adjust the container health check frequency.\nMore notes.",
  });
  host.data.recent = [past];
  host.api.continue = async (id, input) => {
    host.events.push(["continue", id, input]);
    return entry();
  };
  const section = nodes(render(MenuBar), "MenuBarExtra.Section").find((n) => n.props.title === "Recent Work");
  const row = nodes(section, "MenuBarExtra.Item")[0];
  assert.equal(row.props.title, "Health checks");
  assert.equal(row.props.subtitle, "Website · Studio");
  row.props.onAction();
  await new Promise(setImmediate);
  const [, id, input] = host.events.find(([kind]) => kind === "continue");
  assert.equal(id, past.id);
  assert.equal(input.description, past.description);
  assert.equal(input.taskId, past.taskId);
  assert.equal(input.projectId, past.projectId);
});
test("menu recents bound free-text labels and retain useful empty-description fallbacks", () => {
  host.showWhenIdle = true;
  host.data.recent = [
    entry({ id: "long", description: "A long work name ".repeat(20), projectName: "P".repeat(100) }),
    entry({ id: "notes", description: "  Review changes\nA full paragraph of notes  " }),
    entry({ id: "project", description: " ", projectName: "Website" }),
    entry({ id: "blank", description: "" }),
  ];
  const section = nodes(render(MenuBar), "MenuBarExtra.Section").find((n) => n.props.title === "Recent Work");
  const rows = nodes(section, "MenuBarExtra.Item");
  assert.ok(rows[0].props.title.length <= 48);
  assert.ok(rows[0].props.title.endsWith("…"));
  assert.ok(rows[0].props.subtitle.length <= 48);
  assert.equal(rows[1].props.title, "Review changes");
  assert.equal(rows[2].props.title, "Website");
  assert.equal(rows[3].props.title, "No description");
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
