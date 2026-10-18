import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

test('integration imports advance actual server revisions and reject stale device writes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-intervals-http-'));
  const secret = 'a'.repeat(64), uid = 'intervals_user';
  fs.writeFileSync(path.join(dataDir, 'secret'), secret);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'Test' }], creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify({ unit: 'kg', workouts: [], routines: [], bodyweight: [], week: {}, dayPlan: {}, _rev: 1, _wid: 'initial' }));
  const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, ['--import', './test/fixtures/intervals-fetch.mjs', 'server.js'], { cwd, env: { ...process.env, DATA_DIR: dataDir, PORT: '0', RP_ID: 'localhost', ORIGIN: 'http://localhost:8080' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const port = await boundPort(child, () => logs), base = `http://127.0.0.1:${port}`;
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const headers = { Cookie: 'gymsid=' + token, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' };
  const request = (url, method = 'GET', body) => fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base + '/api/intervals/status')).status, 401);
  let res = await request('/api/intervals/connect', 'POST', { apiKey: 'secret-key', timezone: 'UTC' }); assert.equal(res.status, 200);
  res = await request('/api/intervals/sync', 'POST'); assert.equal(res.status, 202);
  for (let i = 0; i < 100; i++) {
    const status = await (await request('/api/intervals/status')).json();
    if (!status.running && status.lastSync) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const doc = await (await request('/api/data')).json();
  assert.equal(doc.state.bodyweight[0].w, 81);
  assert.equal(doc.rev, 2); assert.notEqual(doc.state._wid, 'initial');
  assert.ok(doc.state._wids.includes('initial'));
  res = await request('/api/data', 'PUT', { state: { workouts: [], routines: [], bodyweight: [] }, baseRev: 1, baseWid: 'initial' });
  assert.equal(res.status, 409);
  const integration = JSON.parse(fs.readFileSync(path.join(dataDir, `intervals-${uid}.json`)));
  assert.ok(!JSON.stringify(integration).includes('secret-key'));
  res = await request('/api/intervals/settings', 'PUT', { historyDays: -1 }); assert.equal(res.status, 400);
  res = await request('/api/intervals/connect', 'DELETE'); assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, `intervals-${uid}.json`)), false);
  assert.equal((await (await request('/api/data')).json()).state.bodyweight[0].w, 81);
});
