import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import ts from "typescript";

// Real session storage, API boundary, durable queue, cache gate and recovery
// action. Only native host/transport are replaced. Never touch the OS keychain.
const root = await mkdtemp(join(tmpdir(), "raycast-session-recovery-"));
const host = { values: new Map(), root, cleanups: [] };
globalThis.__raycastSessionProof = host;
const source = (file) => new URL(`../src/${file}`, import.meta.url).href;
const level = Number(
  /export const API_LEVEL = (\d+);/.exec(
    readFileSync(new URL("../src/vendor/shared/api-level.ts", import.meta.url), "utf8"),
  )[1],
);
const mocks = new Map([
  [
    "@raycast/api",
    `const h=globalThis.__raycastSessionProof;
    export const environment={supportPath:h.root,get launchType(){return h.launchType;}};
    export const LocalStorage={getItem:async k=>h.values.get(k),setItem:async(k,v)=>h.values.set(k,v),removeItem:async k=>h.values.delete(k),allItems:async()=>Object.fromEntries(h.values)};
    export const LaunchType={UserInitiated:'user',Background:'background'};
    export const Toast={Style:{Failure:'failure',Success:'success'}};
    export const showToast=async options=>h.toasts.push(options);
    export const launchCommand=async options=>h.launches.push(options);
    export const openExtensionPreferences=async()=>{}; export const getPreferenceValues=()=>({});`,
  ],
  [
    "@raycast/utils",
    `export const useCachedPromise=(loader,args,options)=>{
    const h=globalThis.__raycastSessionProof; h.cachedCall={loader,args,options};
    return {data:h.cached,error:h.error,isLoading:false,revalidate:()=>{},mutate:async promise=>{await h.refreshGate;return promise;}};
  };`,
  ],
  [
    "react",
    `const h=globalThis.__raycastSessionProof;
    export const useState=initial=>{const i=h.cursor++; if(!(i in h.states))h.states[i]=typeof initial==='function'?initial():initial; return [h.states[i],next=>{h.states[i]=typeof next==='function'?next(h.states[i]):next;}];};
    export const useEffect=(effect,deps)=>{const i=h.effectCursor++;const before=h.deps[i];if(!before||deps.some((value,j)=>value!==before[j])){h.cleanups[i]?.();h.deps[i]=deps;h.effects.push(()=>{h.cleanups[i]=effect();});}};
    export const useRef=value=>({current:value}); export const useCallback=fn=>fn;`,
  ],
  [source("lib/preferences.ts"), `export const apiUrl=()=>globalThis.__raycastSessionProof.server;`],
  [
    source("lib/server-level.ts"),
    `export const knownServerApiLevel=async()=>${level}; export const refreshServerLevel=async()=>null; export const noteClientTooOld=async()=>{};`,
  ],
  // Linux CI has no macOS lockf. This suite checks identity recovery in one
  // process; queue-lock.test.mjs verifies the real kernel lock on macOS.
  ...(process.platform === "darwin"
    ? []
    : [[source("lib/queue-lock.ts"), `export const withQueueFileLock=async(_path,task)=>task();`]]),
]);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (mocks.has(specifier)) return { url: `session-proof:${encodeURIComponent(specifier)}`, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href;
      if (mocks.has(candidate)) return { url: `session-proof:${encodeURIComponent(candidate)}`, shortCircuit: true };
      try {
        readFileSync(fileURLToPath(candidate));
        return { url: candidate, shortCircuit: true };
      } catch {}
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("session-proof:"))
      return { format: "module", source: mocks.get(decodeURIComponent(url.slice(14))), shortCircuit: true };
    if (url.endsWith(".ts"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const auth = await import("../src/lib/auth.ts");
const { getTrackYourTime } = await import("../src/lib/api.ts");
const { useApi } = await import("../src/lib/hooks.ts");
const { refreshMenuBar, showFailureToast } = await import("../src/lib/ui.ts");
const { NotSignedInError } = await import("../src/lib/errors.ts");
const { ApiError } = await import("../src/vendor/index.ts");
const originalFetch = globalThis.fetch;
const workspace = { id: "workspace", name: "Synthetic", role: "owner", slug: "synthetic", isDefault: true };
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname.split("/").pop();
  host.requests.push({ path, authorization: options.headers.Authorization ?? options.headers.authorization });
  if (host.fail)
    return Response.json(
      { error: { message: "Session expired", data: { code: "UNAUTHORIZED", httpStatus: 401 } } },
      { status: 401 },
    );
  if (path === "settings.get")
    return Response.json({
      result: { data: { userId: "verified-owner", workspaceId: workspace.id, currency: "EUR" } },
    });
  if (path === "workspaces.list") return Response.json({ result: { data: [workspace] } });
  assert.equal(path, "entries.applyOperation");
  return Response.json({
    result: {
      data: {
        id: "new-entry",
        workspaceId: workspace.id,
        authorId: "verified-owner",
        ...JSON.parse(options.body).input,
        end: null,
      },
    },
  });
};
beforeEach(async () => {
  host.cleanups.forEach((cleanup) => cleanup?.());
  Object.assign(host, {
    server: "https://synthetic.invalid",
    launchType: "user",
    requests: [],
    toasts: [],
    launches: [],
    states: [],
    effects: [],
    deps: [],
    cleanups: [],
    cached: undefined,
    error: undefined,
    fail: false,
    refreshGate: undefined,
  });
  host.values.clear();
  await auth.storeSession({ token: "synthetic-token", userId: "verified-owner", email: "synthetic@example.com" });
});
after(async () => {
  host.cleanups.forEach((cleanup) => cleanup?.());
  globalThis.fetch = originalFetch;
  hook.deregister();
  delete globalThis.__raycastSessionProof;
  await rm(root, { recursive: true, force: true });
});
const render = () => {
  host.cursor = 0;
  host.effectCursor = 0;
  const result = useApi("timer", async () => ({ projects: [] }));
  host.effects.splice(0).forEach((run) => run());
  return result;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a legacy token recovers verified identity before a durable start", async () => {
  host.values.delete("trackyourtime.session.userId");
  // Cached identity is deliberately wrong; never use it to stamp the write.
  host.values.set("trackyourtime.local-cache", JSON.stringify({ settings: { userId: "another-account" } }));
  const api = await getTrackYourTime();
  assert.equal(await auth.getStoredUserId(), "verified-owner");
  await api.start({ description: "Synthetic start" });
  assert.equal(host.requests[0].path, "settings.get");
  assert.ok(host.requests.some((request) => request.path === "entries.applyOperation"));
  assert.ok(host.requests.every((request) => request.authorization === "Bearer synthetic-token"));
});

test("recovered identity stays bound to the token when another account pairs", async () => {
  host.values.delete("trackyourtime.session.userId");
  assert.equal(await auth.rememberSessionUserId("synthetic-token", host.server, "verified-owner"), true);
  host.values.set("trackyourtime.session.token", "another-token");
  assert.equal(await auth.getStoredUserId(), null);
  assert.equal(await auth.rememberSessionUserId("synthetic-token", host.server, "old-owner"), false);
});

test("server refusal invalidates a token without deleting credentials or queued time", async () => {
  host.values.set("trackyourtime.offline-queue", "synthetic-preserved-queue");
  const api = await getTrackYourTime();
  host.fail = true;
  await assert.rejects(api.projects(), (error) => error.httpStatus === 401);
  assert.equal(await auth.getStoredSession(), null);
  assert.equal(host.values.get("trackyourtime.session.token"), "synthetic-token");
  assert.equal(host.values.get("trackyourtime.offline-queue"), "synthetic-preserved-queue");
  const count = host.requests.length;
  await assert.rejects(getTrackYourTime(), NotSignedInError);
  assert.equal(host.requests.length, count);
  await auth.storeSession({ token: "new-token", userId: "verified-owner", email: null });
  assert.equal((await auth.getStoredSession()).token, "new-token");
});

test("late refusal from an old account cannot invalidate a new pairing", async () => {
  await auth.storeSession({ token: "new-token", userId: "new-owner", email: null });
  await auth.markSessionRejected("synthetic-token", host.server);
  assert.equal((await auth.getStoredSession()).token, "new-token");
});

test("missing credentials hide cached projects before loading and then show sign-in", async () => {
  host.values.delete("trackyourtime.session.token");
  host.cached = { workspaceId: null, value: { projects: ["Old project"] } };
  assert.equal(render().data, undefined);
  await settle();
  const result = render();
  assert.equal(result.signedOut, true);
  assert.equal(result.data, undefined);
  assert.equal(host.cachedCall.options.execute, false);
});

test("UI cache requires the current session even in the same workspace", async () => {
  host.cached = { workspaceId: null, sessionKey: "another-session", value: { projects: ["Old project"] } };
  render();
  await settle();
  assert.equal(render().data, undefined);
  host.cached.sessionKey = await auth.sessionCacheKey();
  assert.deepEqual(render().data, { projects: ["Old project"] });
  assert.ok(!host.cachedCall.args[0].includes("synthetic-token"));
  // A network outage keeps this account's known data available.
  host.error = new TypeError("fetch failed");
  assert.deepEqual(render().data, { projects: ["Old project"] });
});

test("changing the server suppresses old data and never sends its token", async () => {
  host.cached = { workspaceId: null, sessionKey: await auth.sessionCacheKey(), value: { projects: ["Old project"] } };
  render();
  await settle();
  assert.ok(render().data);
  host.server = "https://other.invalid";
  auth.notifySessionChanged();
  await settle();
  const result = render();
  assert.equal(result.data, undefined);
  assert.equal(result.signedOut, true);
  await assert.rejects(getTrackYourTime(), NotSignedInError);
  assert.equal(host.requests.length, 0);
});

test("auth read failures hide cached actions without repeating sign-in toasts", async () => {
  host.cached = { workspaceId: null, sessionKey: await auth.sessionCacheKey(), value: { projects: ["Old project"] } };
  render();
  await settle();
  host.error = new ApiError("Expired", "UNAUTHORIZED", 401);
  const result = render();
  assert.equal(result.signedOut, true);
  assert.equal(result.data, undefined);
  host.cachedCall.options.onError(host.error);
  await settle();
  assert.equal(host.toasts.length, 0);
});

test("mutation recovery opens pairing directly instead of relaunching a stale Timer view", async () => {
  await showFailureToast(new NotSignedInError(), "Could not start");
  assert.equal(host.toasts[0].primaryAction.title, "Sign in");
  host.toasts[0].primaryAction.onAction();
  assert.deepEqual(host.launches[0], { name: "entries", type: "user", context: { showTimer: true, signIn: true } });
});

test("timer changes refresh both menu and root-search status without foreground launches", async () => {
  await refreshMenuBar();
  assert.deepEqual(host.launches, [
    { name: "menu-bar", type: "background" },
    { name: "timer", type: "background" },
  ]);
});

test("the toggle can refresh the menu without relaunching itself", async () => {
  await refreshMenuBar(false);
  assert.deepEqual(host.launches, [{ name: "menu-bar", type: "background" }]);
});

test("the menu refresh waits for the cached promise mutation's revalidation", async () => {
  let release;
  host.refreshGate = new Promise((resolve) => {
    release = resolve;
  });
  let finished = false;
  const refresh = render()
    .refresh()
    .then(() => {
      finished = true;
    });
  await settle();
  assert.equal(finished, false);
  release();
  await refresh;
  assert.equal(finished, true);
});

test("background read failures keep cached data without calling the unsupported Toast API", async () => {
  host.launchType = "background";
  host.cached = { workspaceId: null, sessionKey: await auth.sessionCacheKey(), value: { projects: ["Known project"] } };
  render();
  await settle();
  host.error = new TypeError("fetch failed");
  const result = render();
  host.cachedCall.options.onError(host.error);
  await settle();
  assert.deepEqual(result.data, { projects: ["Known project"] });
  assert.equal(host.toasts.length, 0);
});

test("foreground read failures still explain the error", async () => {
  render();
  host.cachedCall.options.onError(new TypeError("fetch failed"));
  await settle();
  assert.equal(host.toasts[0].title, "Could not reach Track Your Time");
});
