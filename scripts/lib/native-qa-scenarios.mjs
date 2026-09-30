import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The same app-flow assertions run inside native WKWebView and Android WebView. */
export async function runNativeScenarios({
  platform,
  appOrigin,
  bundle,
  output,
  evaluate,
  waitFor,
  check,
  screenshot,
  call,
  delay,
  relaunch,
  backgroundResume,
  appearanceCheck,
  startAPI,
}) {
  await check("packaged native launch and login layout", async () => {
    await waitFor(
      `document.querySelector('input[type=email]') && document.documentElement.classList.contains('cap')`,
    );
    const state = await evaluate(
      `return {url:location.href, platform:Capacitor.getPlatform(), width:innerWidth, scrollWidth:document.documentElement.scrollWidth, title:document.title, errors:window.__qaErrors, inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,fontSize:getComputedStyle(e).fontSize})), text:document.body.innerText};`,
    );
    assert(state.url.startsWith(`${appOrigin}/login`), state.url);
    assert.equal(state.platform, platform);
    assert(state.scrollWidth <= state.width + 1, "Horizontal overflow");
    assert.deepEqual(state.errors, []);
    assert(
      state.inputs.every((input) => Number.parseFloat(input.fontSize) >= 16),
      "Native fields must not trigger iOS focus zoom",
    );
    screenshot("login");
    return state;
  });
  await check("native plugins and fake credential persistence", async () => {
    const info = await evaluate(`return await ${call("App", "getInfo")};`);
    assert.equal(info.id, bundle);
    const network = await evaluate(
      `return await ${call("Network", "getStatus")};`,
    );
    assert.equal(typeof network.connected, "boolean");
    await evaluate(
      `await ${call("SecureStorage", "internalSetItem", { prefixedKey: "qa.sentinel", data: "fake-only" })}; await ${call("Preferences", "set", { key: "qa.sentinel", value: "persistent" })}; return true;`,
    );
    await relaunch();
    await waitFor(`document.querySelector('input[type=email]')`);
    const persisted = await evaluate(
      `return {credential:await ${call("SecureStorage", "internalGetItem", { prefixedKey: "qa.sentinel" })}, preference:await ${call("Preferences", "get", { key: "qa.sentinel" })}};`,
    );
    assert.equal(persisted.credential.data, "fake-only");
    assert.equal(persisted.preference.value, "persistent");
    await evaluate(
      `await ${call("SecureStorage", "internalRemoveItem", { prefixedKey: "qa.sentinel" })}; await ${call("Preferences", "remove", { key: "qa.sentinel" })}; return true;`,
    );
    const removed = await evaluate(
      `return await ${call("SecureStorage", "internalGetItem", { prefixedKey: "qa.sentinel" })};`,
    );
    assert.equal(removed.data, null);
    return { info, network, persisted, removed };
  });
  await check("native background and resume", async () => {
    await waitFor(`(await ${call("App", "getState")}).isActive`);
    await evaluate(
      `window.__qaVisibility=[]; window.Capacitor.addListener('App','appStateChange',e=>window.__qaVisibility.push(e.isActive)); return true;`,
    );
    await backgroundResume();
    await waitFor(
      `document.visibilityState === 'visible' && (await ${call("App", "getState")}).isActive`,
    );
    const evidence = await evaluate(
      `return {events:window.__qaVisibility, state:await ${call("App", "getState")}, errors:window.__qaErrors};`,
    );
    assert.equal(evidence.state.isActive, true);
    assert(
      evidence.events.includes(false) && evidence.events.includes(true),
      JSON.stringify(evidence),
    );
    assert.deepEqual(evidence.errors, []);
    return evidence;
  });
  await appearanceCheck();
  await check("bundled auth navigation", async () => {
    const links = await evaluate(
      `return [...document.querySelectorAll('a')].map(a=>({text:a.innerText,path:new URL(a.href).pathname}));`,
    );
    const destinations = links.filter((link) =>
      /signup|sign-up|forgot-password/.test(link.path),
    );
    assert(destinations.length > 0, "Expected bundled auth links");
    for (const { path } of destinations) {
      await evaluate(
        `const target=${JSON.stringify(path)}.split('/').filter(Boolean).join('/'); const link=[...document.querySelectorAll('a')].find(a=>new URL(a.href).pathname.split('/').filter(Boolean).join('/')===target); if(!link) throw new Error('Missing auth link: '+target); link.click(); return true;`,
      );
      await waitFor(
        `location.pathname === ${JSON.stringify(path)} || location.pathname === ${JSON.stringify(path + "/")} || location.pathname + '/' === ${JSON.stringify(path)}`,
      );
      assert.deepEqual(await evaluate("return window.__qaErrors;"), []);
      screenshot(path.replaceAll("/", "") || "auth");
      // Schedule navigation after returning the command response.
      await evaluate(`setTimeout(()=>history.back(),100); return true;`);
      await waitFor(
        `location.pathname.startsWith('/login') && document.querySelector('input[type=email]')`,
      );
    }
    return destinations;
  });
  const api = await startAPI();
  const click = (testID) =>
    evaluate(
      `document.querySelector('[data-testid="${testID}"]').click(); return true;`,
    );
  const fill = (selector, value) =>
    evaluate(
      `const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true;`,
    );
  await check("server selection and native bearer login", async () => {
    await waitFor(
      `document.querySelector('[data-testid="server-picker-toggle"]')`,
    );
    await click("server-picker-toggle");
    await waitFor(
      `document.querySelector('[data-testid="server-picker-own"]')`,
    );
    await click("server-picker-own");
    await waitFor(
      `document.querySelector('[data-testid="server-picker-address"]')`,
    );
    await fill('[data-testid="server-picker-address"]', api.origin);
    await click("server-picker-save");
    await waitFor(
      `document.querySelector('[data-testid="server-picker-current"]')?.innerText.includes('127.0.0.1')`,
    );
    await fill('[data-testid="login-email"]', api.account.email);
    await fill('[data-testid="login-password"]', api.account.password);
    await click("login-submit");
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')`,
      45000,
    );
    let trpc = [];
    let upgrades = [];
    // The first tracker render precedes its batched queries and socket setup.
    for (let n = 0; n < 60; n++) {
      const requests = readFileSync(join(output, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      trpc = requests.filter(
        (r) =>
          !r.harness &&
          r.url.startsWith("/api/trpc/") &&
          r.method !== "OPTIONS",
      );
      upgrades = requests.filter((r) => !r.harness && r.kind === "upgrade");
      if (trpc.length && upgrades.length) break;
      await delay(250);
    }
    assert(trpc.length > 0, "No native API requests recorded");
    assert(upgrades.length > 0, "No native WebSocket upgrade recorded");
    assert(
      trpc.every(
        (r) =>
          r.authorization === "Bearer" &&
          !r.cookie &&
          r.client === "trackyourtime-mobile",
      ),
      "Native tRPC must identify mobile and use bearer without cookies",
    );
    assert(
      upgrades.every((r) => r.protocol === "bearer" && !r.cookie),
      "Native WebSocket must use bearer without cookies",
    );
    screenshot("signed-in");
    return {
      server: api.origin,
      nativeRequests: trpc.length,
      bearerWithoutCookies: true,
    };
  });
  await check("timer start, cold relaunch, and stop", async () => {
    await fill(
      '[data-testid="tracker-description"]',
      "Native simulator QA timer",
    );
    await click("tracker-toggle");
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')?.dataset.state === 'running'`,
    );
    let entry;
    for (let n = 0; n < 40; n++) {
      entry = await api.trpc("entries.current");
      if (entry?.description === "Native simulator QA timer") break;
      await delay(250);
    }
    assert.equal(entry?.description, "Native simulator QA timer");
    assert.equal(entry.source, "mobile");
    await relaunch();
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')?.dataset.state === 'running'`,
    );
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-testid="tracker-description"]').value;`,
      ),
      "Native simulator QA timer",
    );
    screenshot("timer-after-relaunch");
    await click("tracker-toggle");
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')?.dataset.state === 'idle'`,
    );
    for (let n = 0; n < 40; n++) {
      if ((await api.trpc("entries.current")) === null) break;
      await delay(250);
    }
    assert.equal(await api.trpc("entries.current"), null);
    return {
      source: entry.source,
      persistedAcrossRelaunch: true,
      stoppedOnServer: true,
    };
  });
  await check("offline mutation queue and resume sync", async () => {
    await evaluate(
      `window.__qaOriginalFetch=window.fetch; window.fetch=(input,init)=>String(input instanceof Request?input.url:input).includes('/api/trpc/entries.')?Promise.reject(new TypeError('Failed to fetch')):window.__qaOriginalFetch(input,init); return true;`,
    );
    await fill(
      '[data-testid="tracker-description"]',
      "Offline native QA timer",
    );
    await click("tracker-toggle");
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')?.dataset.state === 'running' && document.querySelector('[data-testid="offline-pending"]')`,
      45000,
    );
    assert.equal(
      await api.trpc("entries.current"),
      null,
      "Offline change unexpectedly reached API",
    );
    screenshot("offline-queued");
    await evaluate(`window.fetch=window.__qaOriginalFetch; return true;`);
    await backgroundResume();
    await waitFor(
      `(await ${call("App", "getState")}).isActive && !document.querySelector('[data-testid="offline-pending"]')`,
      45000,
    );
    const entry = await api.trpc("entries.current");
    assert.equal(entry?.description, "Offline native QA timer");
    await click("tracker-toggle");
    await waitFor(
      `document.querySelector('[data-testid="tracker-toggle"]')?.dataset.state === 'idle'`,
    );
    return { queuedWithoutReachingServer: true, flushedOnResume: true };
  });
  await check("remote session revocation", async () => {
    const devices = await api.trpc("devices.list");
    const mobile = devices.find(
      (d) => d.client === "mobile" || d.client === "ios",
    );
    assert(
      mobile,
      `No mobile session: ${JSON.stringify(devices.map((d) => ({ client: d.client, name: d.name })))}`,
    );
    await api.trpc("devices.revoke", { id: mobile.id }, true);
    await waitFor(
      `location.pathname.startsWith('/login') && document.querySelector('[data-testid="login-revoked"]')`,
      90000,
    );
    const state = await evaluate(
      `return {notice:document.querySelector('[data-testid="login-revoked"]').innerText,errors:window.__qaErrors};`,
    );
    assert.deepEqual(state.errors, []);
    screenshot("session-revoked");
    return state;
  });
}
