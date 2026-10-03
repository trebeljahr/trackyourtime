// Real Caddy, fake upstreams, loopback only. No production calls or records.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = fileURLToPath(new URL('./Caddyfile', import.meta.url));
const serve = fileURLToPath(new URL('../../packages/client/serve.mjs', import.meta.url));
const listen = async server => {
  // Explicit high port, fail on conflicts rather than touching other processes.
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 49152 + Math.floor(Math.random() * 16000);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      server.removeAllListeners('error');
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('Three high ports occupied');
};
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL'); // Owned fixture processes only; serve.mjs drains for 20s.
  await exited;
};
const ready = async (url, child, logs) => {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs());
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Fixture not ready: ${logs()}`);
};

test('local gateway preserves the hosted HTTP, auth, static and socket contracts', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tyt-origin-proof-'));
  let gateway, web, releaseStream;
  const seen = [];
  const api = createServer(async (req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: 'https://api.example.test/api/auth/callback/google' });
      res.end();
    } else if (req.url === '/api/cookies') {
      res.writeHead(200, { 'set-cookie': [
        '__Secure-better-auth.session_token=fake; Path=/; Secure; HttpOnly; SameSite=Lax',
        'state=fake; Path=/; HttpOnly; SameSite=Lax',
      ] });
      res.end('ok');
    } else if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first');
      await new Promise(resolve => { releaseStream = resolve; });
      res.end('last');
    } else {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(req.url === '/api/failure' ? 401 : 200, {
        'content-type': 'application/json', 'x-trackyourtime-api-level': '1',
      });
      res.end(JSON.stringify({ url: req.url, body }));
    }
  });
  api.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, method: 'UPGRADE', headers: req.headers });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: fixture\r\n\r\n`);
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
  });
  try {
    const apiPort = await listen(api);
    const reservation = createServer();
    const webPort = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const edgeReservation = createServer();
    const edgePort = await listen(edgeReservation);
    await new Promise(resolve => edgeReservation.close(resolve));
    const env = { ...process.env, GATEWAY_PORT: String(edgePort), API_UPSTREAM: `http://127.0.0.1:${apiPort}`, WEB_UPSTREAM: `http://127.0.0.1:${webPort}` };
    const origin = `http://127.0.0.1:${edgePort}`;
    await mkdir(join(root, 'out', '_next', 'static'), { recursive: true });
    await writeFile(join(root, 'out', 'index.html'), '<p>fixture</p>');
    await writeFile(join(root, 'out', 'version.json'), '{"apiUrl":"","commit":"fixture"}');
    await writeFile(join(root, 'out', '_next', 'static', 'fixture.js'), 'fixture');
    await cp(serve, join(root, 'serve.mjs'));
    web = spawn(process.execPath, [join(root, 'serve.mjs')], { env: { ...env, PORT: String(webPort), HOST: '127.0.0.1' }, stdio: 'ignore' });
    await ready(env.WEB_UPSTREAM, web, () => 'Static fixture failed');
    const validation = spawnSync('caddy', ['validate', '--config', config, '--adapter', 'caddyfile'], { env, encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
    let logs = '';
    gateway = spawn('caddy', ['run', '--config', config, '--adapter', 'caddyfile'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', data => { logs += data; });
    gateway.stderr.on('data', data => { logs += data; });
    await ready(origin, gateway, () => logs);
    await t.test('POST retains mount, batch query, body, credentials and version headers', async () => {
      const response = await fetch(`${origin}/api/trpc/entries.list?batch=1&input=%7B%7D`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: 'session=fake', authorization: 'Bearer fake', origin,
          'x-trackyourtime-client': 'web', 'x-trackyourtime-client-version': '0.2.2', 'x-trackyourtime-api-level': '1' }, body: '{"fixture":true}',
      });
      assert.equal(response.headers.get('x-trackyourtime-api-level'), '1');
      assert.deepEqual(await response.json(), { url: '/api/trpc/entries.list?batch=1&input=%7B%7D', body: '{"fixture":true}' });
      const last = seen.at(-1);
      assert.equal(last.headers.cookie, 'session=fake');
      assert.equal(last.headers.authorization, 'Bearer fake');
      assert.equal(last.headers.origin, origin);
      assert.equal(last.headers.host, `127.0.0.1:${apiPort}`);
      assert.equal(last.headers['x-forwarded-host'], `127.0.0.1:${edgePort}`);
      assert.equal(last.headers['x-trackyourtime-client'], 'web');
      assert.equal(last.headers['x-trackyourtime-client-version'], '0.2.2');
      assert.equal(last.headers['x-trackyourtime-api-level'], '1');
    });
    await t.test('cookie attributes and separate Set-Cookie fields pass unchanged', async () => {
      const response = await fetch(`${origin}/api/cookies`);
      assert.deepEqual(response.headers.getSetCookie(), [
        '__Secure-better-auth.session_token=fake; Path=/; Secure; HttpOnly; SameSite=Lax',
        'state=fake; Path=/; HttpOnly; SameSite=Lax',
      ]);
    });
    await t.test('auth redirects stay absolute; no unsafe Location rewriting', async () => {
      const response = await fetch(`${origin}/api/redirect`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://api.example.test/api/auth/callback/google');
    });
    await t.test('API errors and exact /api reach upstream', async () => {
      assert.equal((await fetch(`${origin}/api/failure`)).status, 401);
      assert.equal((await (await fetch(`${origin}/api`)).json()).url, '/api');
    });
    await t.test('existing static redirects, cache headers and version marker survive', async () => {
      const moved = await fetch(`${origin}/track?x=1`, { redirect: 'manual' });
      assert.equal(moved.status, 308);
      assert.equal(moved.headers.get('location'), '/app/track?x=1');
      const version = await fetch(`${origin}/version.json`);
      assert.equal(version.headers.get('cache-control'), 'no-cache');
      assert.equal((await version.json()).apiUrl, '');
      assert.equal((await fetch(`${origin}/_next/static/fixture.js`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal((await fetch(`${origin}/apix`)).status, 404);
    });
    await t.test('responses stream before upstream finishes', async () => {
      const response = await fetch(`${origin}/api/stream`);
      const reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
      releaseStream();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'last');
    });
    for (const path of ['/api/ws', '/ws']) {
      await t.test(`WebSocket upgrade preserves ${path}, cookie and token protocol`, async () => {
        await new Promise((resolve, reject) => {
          const req = request(`${origin}${path}`, { headers: { connection: 'Upgrade', upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
            'sec-websocket-protocol': 'fixture', cookie: 'session=fake' } });
          req.on('error', reject);
          req.on('response', res => reject(new Error(`Expected upgrade, got ${res.statusCode}`)));
          req.on('upgrade', (res, socket) => {
            socket.destroy();
            try {
              assert.equal(res.statusCode, 101);
              assert.equal(res.headers['sec-websocket-protocol'], 'fixture');
              assert.equal(seen.at(-1).url, path);
              assert.equal(seen.at(-1).headers.cookie, 'session=fake');
              assert.equal(seen.at(-1).headers['sec-websocket-protocol'], 'fixture');
              resolve();
            } catch (error) { reject(error); }
          });
          req.end();
        });
      });
    }
    await t.test('separate public API remains usable', async () => {
      assert.equal((await fetch(`${env.API_UPSTREAM}/api/health`)).status, 200);
    });
    await t.test('upstream failure is 502, never a static success', async () => {
      api.closeAllConnections();
      await new Promise(resolve => api.close(resolve));
      assert.equal((await fetch(`${origin}/api/health`)).status, 502);
    });
  } finally {
    releaseStream?.();
    await stop(gateway);
    await stop(web);
    api.closeAllConnections();
    api.close();
    await rm(root, { recursive: true, force: true });
  }
});
