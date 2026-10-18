import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntervalsSync } from '../intervals-sync.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntervalsError } from '../intervals-client.js';
import { intervalsRoutes } from '../intervals-routes.js';

function setup(over = {}) {
  const calls = [], json = (res, status, data) => { Object.assign(res, { status, data }); };
  const sync = { status: () => ({ connected: false }), connect: async (...a) => { calls.push(a); return { connected: true }; }, configure: () => ({}), run: async () => {}, resolve: async () => ({}), disconnect: async () => ({ connected: false }) };
  const routes = intervalsRoutes({ sync, json, readBody: req => req.body || {}, readSession: req => req.user, origin: 'https://gym.example', oauth: { clientId: 'client', clientSecret: 'secret' }, ...over });
  return { routes, calls, async request(key, body, user = { id: 'u' }, url = '/') { const res = { writeHead(status, headers) { Object.assign(this, { status, headers }); }, end() {} }; await routes[key]({ user, body, url }, res); return res; } };
}
test('every integration route except OAuth callback requires an authenticated profile', async () => {
  const h = setup();
  for (const key of Object.keys(h.routes).filter(k => !k.endsWith('/callback'))) {
    const res = await h.request(key, {}, null); assert.equal(res.status, 401, key);
  }
});
test('connect forwards only the current profile and reports safe client errors', async () => {
  const h = setup(); const res = await h.request('POST /api/intervals/connect', { apiKey: 'my-key' });
  assert.equal(res.status, 200); assert.equal(h.calls[0][0], 'u');
  assert.deepEqual(h.calls[0][1], { apiKey: 'my-key' });
});
test('OAuth state is bound to the profile, expires, and cannot be replayed', async () => {
  let clock = 1;
  const h = setup({ now: () => clock, fetchImpl: async () => Response.json({ access_token: 'oauth-secret', scope: 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE' }) });
  const start = await h.request('POST /api/intervals/oauth/start', { timezone: 'Europe/Zurich' });
  const url = new URL(start.data.url), state = url.searchParams.get('state');
  assert.equal(url.hostname, 'intervals.icu');
  const wrong = await h.request('GET /api/intervals/oauth/callback', null, { id: 'other' }, '/api/intervals/oauth/callback?code=code&state=' + state);
  assert.equal(wrong.status, 400);
  const next = await h.request('POST /api/intervals/oauth/start', {});
  const valid = new URL(next.data.url).searchParams.get('state');
  const good = await h.request('GET /api/intervals/oauth/callback', null, { id: 'u' }, '/api/intervals/oauth/callback?code=code&state=' + valid);
  assert.equal(good.status, 303);
  assert.equal(good.headers.Location, 'https://gym.example/#/settings/data');
  assert.equal(h.calls[0][2].accessToken, 'oauth-secret');
  const again = await h.request('GET /api/intervals/oauth/callback', null, { id: 'u' }, '/api/intervals/oauth/callback?code=code&state=' + valid);
  assert.equal(again.status, 400);
  const exp = await h.request('POST /api/intervals/oauth/start', {}); clock += 11 * 60000;
  const expired = await h.request('GET /api/intervals/oauth/callback', null, { id: 'u' }, '/?code=code&state=' + new URL(exp.data.url).searchParams.get('state'));
  assert.equal(expired.status, 400);
});

test('resolve forwards the reviewed snapshot token and preserves conflict responses', async () => {
  const calls = [];
  const h = setup({ sync: { resolve: async (...args) => {
    calls.push(args);
    if (!args[3]) throw new IntervalsError('Review the current conflict before choosing a side.', 409);
    return { conflicts: [] };
  } } });
  const good = await h.request('POST /api/intervals/resolve', { id: 'activity:w', choice: 'local', token: 'reviewed-token' });
  assert.equal(good.status, 200);
  assert.deepEqual(calls[0], ['u', 'activity:w', 'local', 'reviewed-token']);
  const missing = await h.request('POST /api/intervals/resolve', { id: 'activity:w', choice: 'local' });
  assert.equal(missing.status, 409);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const grant = token => Response.json({ access_token: token, scope: 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE' });
async function oauthState(h) {
  const start = await h.request('POST /api/intervals/oauth/start', {});
  return new URL(start.data.url).searchParams.get('state');
}
const callback = (h, state) => h.request('GET /api/intervals/oauth/callback', null, { id: 'u' }, '/api/intervals/oauth/callback?code=code&state=' + state);

test('disconnect cancels an OAuth callback awaiting its token exchange', async () => {
  const token = deferred(), entered = deferred();
  const h = setup({ fetchImpl: async () => { entered.resolve(); return token.promise; } });
  const state = await oauthState(h), completing = callback(h, state);
  await entered.promise;
  await h.request('DELETE /api/intervals/connect');
  token.resolve(grant('cancelled-secret'));
  assert.equal((await completing).status, 409);
  assert.equal(h.calls.length, 0);
  assert.equal((await callback(h, state)).status, 400);
});

test('a newer OAuth flow wins over an older callback awaiting its token exchange', async () => {
  const token = deferred(), entered = deferred(); let requests = 0;
  const h = setup({ fetchImpl: async () => {
    if (++requests === 1) { entered.resolve(); return token.promise; }
    return grant('new-secret');
  } });
  const completing = callback(h, await oauthState(h));
  await entered.promise;
  assert.equal((await callback(h, await oauthState(h))).status, 303);
  token.resolve(grant('old-secret'));
  assert.equal((await completing).status, 409);
  assert.deepEqual(h.calls.map(call => call[2].accessToken), ['new-secret']);
});

test('an API key connection supersedes an OAuth callback awaiting its token exchange', async () => {
  const token = deferred(), entered = deferred();
  const h = setup({ fetchImpl: async () => { entered.resolve(); return token.promise; } });
  const completing = callback(h, await oauthState(h));
  await entered.promise;
  assert.equal((await h.request('POST /api/intervals/connect', { apiKey: 'new-api-key' })).status, 200);
  token.resolve(grant('old-secret'));
  assert.equal((await completing).status, 409);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].apiKey, 'new-api-key');
});

for (const method of ['oauth', 'apiKey']) test(`a newer OAuth start cancels ${method} athlete validation before credentials are saved`, async t => {
  const athlete = deferred(), entered = deferred();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intervals-route-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let validating = true;
  const fetchImpl = async url => {
    if (url.endsWith('/api/oauth/token')) return grant('old-secret');
    assert.equal(url, 'https://intervals.icu/api/v1/athlete/0');
    if (validating) { validating = false; entered.resolve(); return athlete.promise; }
    return Response.json({ id: 'new-athlete' });
  };
  const sync = createIntervalsSync({ dataDir, secret: 'test-secret', readState: () => ({}), writeState: () => {}, fetchImpl });
  const h = setup({ sync, fetchImpl });
  const completing = method === 'oauth' ? callback(h, await oauthState(h)) : h.request('POST /api/intervals/connect', { apiKey: 'old-api-key' });
  await entered.promise;
  const replacement = await oauthState(h);
  athlete.resolve(Response.json({ id: 'old-athlete' }));
  assert.equal((await completing).status, 409);
  assert.equal(sync.status('u').connected, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'intervals-u.json')), false);
  // The canceled request's cleanup must leave the replacement state usable.
  assert.equal((await callback(h, replacement)).status, 303);
  assert.equal(sync.status('u').connected, true);
});

for (const route of ['POST /api/intervals/oauth/start', 'POST /api/intervals/connect']) test(`disconnect cancels ${route} while its request body is pending`, async () => {
  const body = deferred(), entered = deferred();
  const h = setup({ readBody: async () => { entered.resolve(); return body.promise; } });
  const starting = h.request(route);
  await entered.promise;
  await h.request('DELETE /api/intervals/connect');
  body.resolve({ apiKey: 'old-api-key' });
  assert.equal((await starting).status, 409);
  assert.equal(h.calls.length, 0);
});

test('re-sync queues only the signed-in profile and returns running status', async () => {
  const calls = [];
  const h = setup({ sync: {
    resyncActivities: uid => calls.push(['resync', uid]),
    run: async uid => calls.push(['run', uid]),
    status: () => ({ connected: true, running: true, resyncRemaining: 3 }),
  } });
  const res = await h.request('POST /api/intervals/resync-activities');
  assert.equal(res.status, 202);
  assert.equal(res.data.resyncRemaining, 3);
  assert.deepEqual(calls, [['resync', 'u'], ['run', 'u']]);
});
