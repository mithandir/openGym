import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntervalsSync } from '../intervals-sync.js';
import { createIntervalsClient } from '../intervals-client.js';

const now = Date.parse('2026-10-18T10:00:00Z');
const workout = { id: 'w1', d: '2026-10-18', name: 'Gym', start: now - 3600000, end: now, entries: [], note: '' };
function harness(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-intervals-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let state = { unit: 'kg', workouts: [structuredClone(workout)], bodyweight: [], routines: [], dayPlan: {}, week: {} };
  const remote = { activities: [], events: [], wellness: [], calls: [] };
  let failure = null, hold = null;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    remote.calls.push([method, u.pathname]);
    if (hold) await hold;
    if (failure) { const f = failure; failure = null; throw f; }
    if (u.pathname.endsWith('/athlete/0')) return Response.json({ id: 'i1', name: 'Athlete' });
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'GET' && /\/(activities|events|wellness)$/.test(u.pathname)) return Response.json(remote[u.pathname.split('/').at(-1)].filter(r => (r.start_date_local || r.id) >= u.searchParams.get('oldest') && (r.start_date_local || r.id).slice(0, 10) <= u.searchParams.get('newest')));
    if (u.pathname.endsWith('/activities/manual/bulk')) {
      return Response.json(body.map(v => {
        let r = remote.activities.find(r => r.external_id === v.external_id);
        if (!r) { r = { id: 'a' + remote.activities.length }; remote.activities.push(r); }
        Object.assign(r, v); return r;
      }));
    }
    if (u.pathname.endsWith('/events/bulk')) {
      return Response.json(body.map(v => {
        let r = remote.events.find(r => r.external_id === v.external_id);
        if (!r) { r = { id: remote.events.length + 1 }; remote.events.push(r); }
        Object.assign(r, v); return r;
      }));
    }
    const m = /\/(activity|events|wellness)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const arr = remote[m[1] === 'activity' ? 'activities' : m[1]];
      let r = arr.find(r => String(r.id) === decodeURIComponent(m[2]));
      if (method === 'DELETE') { if (r) arr.splice(arr.indexOf(r), 1); return Response.json({}); }
      if (method === 'PUT') {
        if (!r) { r = { id: decodeURIComponent(m[2]) }; arr.push(r); }
        // Live API behavior: numeric wellness nulls are ignored; -1 clears the field.
        if (m[1] === 'wellness' && body.weight === null) { /* ignored */ }
        else Object.assign(r, m[1] === 'wellness' && body.weight === -1 ? { weight: null } : body);
      }
      return r ? Response.json(r) : Response.json({}, { status: 404 });
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  };
  const deps = { dataDir, secret: 'a'.repeat(64), readState: () => structuredClone(state), writeState: (_, next) => { state = structuredClone(next); }, userExists: () => true, now: () => now, fetchImpl, ...overrides };
  const sync = createIntervalsSync(deps);
  return { sync, remote, dataDir, get state() { return state; }, set state(v) { state = v; }, fail: e => { failure = e; }, hold: p => { hold = p; }, deps };
}
const connect = h => h.sync.connect('u', { apiKey: 'personal-secret', timezone: 'Europe/Zurich', historyDays: 90, futureDays: 42 });

test('polling upserts once, persists links across restart, and encrypts credentials', async t => {
  const h = harness(t); await connect(h);
  await h.sync.run('u'); await h.sync.run('u');
  assert.equal(h.remote.activities.length, 1);
  const disk = fs.readFileSync(path.join(h.dataDir, 'intervals-u.json'), 'utf8');
  assert.ok(!disk.includes('personal-secret'));
  assert.ok(!JSON.stringify(h.sync.status('u')).includes('personal-secret'));
  const restarted = createIntervalsSync(h.deps); await restarted.run('u');
  assert.equal(h.remote.activities.length, 1);
  assert.equal(h.remote.calls.filter(([method]) => method === 'POST').length, 1);
});

test('one-sided remote edit imports; concurrent edits require an explicit unchanged snapshot choice', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.remote.activities[0].name = 'Remote edit'; await h.sync.run('u');
  assert.equal(h.state.workouts[0].name, 'Remote edit');
  h.state.workouts[0].name = 'Local edit'; h.remote.activities[0].name = 'Both changed';
  await h.sync.run('u');
  const [conflict] = h.sync.status('u').conflicts;
  assert.equal(conflict.kind, 'activity');
  await h.sync.resolve('u', conflict.id, 'local', conflict.token);
  assert.equal(h.remote.activities[0].name, 'Local edit');
  assert.deepEqual(h.sync.status('u').conflicts, []);
});

test('disappearance is reviewed, and a moved record outside the query window is fetched individually', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.remote.activities[0].start_date_local = '2026-06-01T10:00:00';
  await h.sync.run('u');
  assert.equal(h.sync.status('u').conflicts.length, 0);
  assert.equal(h.state.workouts[0].d, '2026-06-01');
  // Move it back so it is in the configured scope before deleting it.
  h.remote.activities[0].start_date_local = '2026-10-18T10:00:00'; await h.sync.run('u');
  h.remote.activities.length = 0; await h.sync.run('u');
  const [conflict] = h.sync.status('u').conflicts;
  assert.ok(conflict); assert.equal(h.state.workouts.length, 1);
  await h.sync.resolve('u', conflict.id, 'remote', conflict.token);
  assert.equal(h.state.workouts.length, 0);
});

test('weight collisions require review and only the weight wellness field is written', async t => {
  const h = harness(t); h.state.bodyweight = [{ d: '2026-10-18', w: 80 }];
  h.remote.wellness = [{ id: '2026-10-18', weight: 81, restingHR: 50 }];
  await connect(h); await h.sync.run('u');
  const c = h.sync.status('u').conflicts.find(c => c.kind === 'weight');
  assert.ok(c); await h.sync.resolve('u', c.id, 'local', c.token);
  assert.equal(h.remote.wellness[0].weight, 80);
  assert.equal(h.remote.wellness[0].restingHR, 50);
});

test('confirmed local weigh-in deletion clears only remote weight using the numeric sentinel', async t => {
  const h = harness(t); h.state.bodyweight = [{ d: '2026-10-18', w: 80 }];
  h.remote.wellness = [{ id: '2026-10-18', weight: 80, restingHR: 50 }];
  await connect(h); await h.sync.run('u');
  h.state.bodyweight = []; await h.sync.run('u');
  const conflict = h.sync.status('u').conflicts.find(c => c.kind === 'weight');
  assert.ok(conflict); await h.sync.resolve('u', conflict.id, 'local', conflict.token);
  assert.equal(h.remote.wellness[0].weight, null);
  assert.equal(h.remote.wellness[0].restingHR, 50);
});

test('network failures retain checkpoints and enforce backoff; manual calls cannot bypass rate limits', async t => {
  const h = harness(t); await connect(h);
  h.fail(Object.assign(new Error('rate limit'), { status: 429, retryAfter: 1200 }));
  await h.sync.run('u');
  const status = h.sync.status('u'); assert.ok(status.error); assert.ok(status.nextRun >= now + 1200000);
  const calls = h.remote.calls.length; await h.sync.run('u');
  assert.equal(h.remote.calls.length, calls);
});

test('overlapping runs serialize and disconnect cancels a pending import', async t => {
  const h = harness(t); await connect(h);
  let release; h.hold(new Promise(r => { release = r; }));
  const a = h.sync.run('u'), b = h.sync.run('u');
  await h.sync.disconnect('u'); release(); await Promise.all([a, b]);
  assert.equal(h.sync.status('u').connected, false);
  assert.equal(h.remote.activities.length, 0);
});

test('a local edit during network reads is compared using the current state', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.remote.activities[0].name = 'Remote';
  let release; h.hold(new Promise(r => { release = r; }));
  const run = h.sync.run('u'); h.state.workouts[0].name = 'Edited while fetching'; release(); await run;
  assert.equal(h.state.workouts[0].name, 'Edited while fetching');
  assert.equal(h.sync.status('u').conflicts.length, 1);
});

test('moving a linked remote plan onto an occupied OpenGym date requires review and preserves both prescriptions', async t => {
  const h = harness(t);
  h.state.routines = [{ id: 'a', name: 'A', ex: [] }, { id: 'b', name: 'B', ex: [] }];
  h.state.dayPlan = { '2026-10-19': 'a', '2026-10-20': 'b' };
  await connect(h); await h.sync.run('u');
  h.remote.events.find(r => r.name === 'A').start_date_local = '2026-10-20T00:00:00';
  // Delete B remotely: its deletion is unconfirmed, so the local B still occupies the 20th.
  h.remote.events = h.remote.events.filter(r => r.name !== 'B');
  await h.sync.run('u');
  assert.equal(h.state.dayPlan['2026-10-20'], 'b');
  assert.ok(h.sync.status('u').conflicts.some(c => c.blocked));
});

test('disconnect during connection validation cannot restore credentials after deletion', async t => {
  const h = harness(t);
  let release; h.hold(new Promise(r => { release = r; }));
  const connecting = connect(h);
  await h.sync.disconnect('u'); release();
  await assert.rejects(connecting);
  assert.equal(h.sync.status('u').connected, false);
});

test('a native Intervals gym plan imports as a dated reviewable routine and does not duplicate', async t => {
  const h = harness(t); h.state.workouts = [];
  h.remote.events = [{ id: 42, name: 'Native gym', type: 'WeightTraining', category: 'WORKOUT', start_date_local: '2026-10-20T17:00:00', description: 'Squat 3 x 5' }];
  await connect(h); await h.sync.run('u'); await h.sync.run('u');
  assert.equal(h.sync.status('u').error, null);
  const r = h.state.routines.find(r => r.id === h.state.dayPlan['2026-10-20']);
  assert.ok(r); assert.equal(r.note, 'Squat 3 x 5'); assert.equal(r.intervalsPlan.needsReview, true);
  assert.equal(h.remote.events.length, 1); assert.equal(h.state.routines.length, 1);
  h.remote.events = []; await h.sync.run('u');
  const deletion = h.sync.status('u').conflicts[0];
  await h.sync.resolve('u', deletion.id, 'remote', deletion.token);
  assert.equal(h.sync.status('u').reviews.length, 0);
});

test('moving an imported plan in OpenGym pushes the new date instead of appearing deleted', async t => {
  const h = harness(t); h.state.workouts = [];
  h.remote.events = [{ id: 42, name: 'Native gym', type: 'WeightTraining', category: 'WORKOUT', start_date_local: '2026-10-20T17:00:00', description: 'Squat' }];
  await connect(h); await h.sync.run('u');
  const id = h.state.dayPlan['2026-10-20'];
  h.state.dayPlan['2026-10-20'] = 'rest'; h.state.dayPlan['2026-10-21'] = id;
  await h.sync.run('u');
  assert.equal(h.remote.events[0].start_date_local, '2026-10-21T17:00:00');
  assert.equal(h.sync.status('u').conflicts.length, 0);
  h.state.routines.push({ id: 'b', name: 'Replacement after move', ex: [] });
  h.state.dayPlan['2026-10-21'] = 'b'; await h.sync.run('u');
  assert.equal(h.remote.events[0].name, 'Replacement after move');
  assert.equal(h.remote.events.length, 1); assert.equal(h.sync.status('u').conflicts.length, 0);
});

test('replacing an imported plan on its existing day updates the linked event without duplicates', async t => {
  const h = harness(t); h.state.workouts = [];
  h.remote.events = [{ id: 42, name: 'A', type: 'WeightTraining', category: 'WORKOUT', start_date_local: '2026-10-20T17:00:00', description: 'Original' }];
  await connect(h); await h.sync.run('u');
  h.state.routines.push({ id: 'b', name: 'B', ex: [], note: 'Replacement' }); h.state.dayPlan['2026-10-20'] = 'b';
  await h.sync.run('u'); await h.sync.run('u');
  assert.equal(h.remote.events.length, 1); assert.equal(h.remote.events[0].name, 'B');
  assert.equal(h.sync.status('u').conflicts.length, 0); assert.equal(h.state.dayPlan['2026-10-20'], 'b');
});

test('HTTP client bounds responses, does not follow redirects, and respects Retry-After', async () => {
  const client = createIntervalsClient({ apiKey: 'key' }, { fetchImpl: async (_, init) => {
    assert.equal(init.redirect, 'error'); assert.match(init.headers.Authorization, /^Basic /);
    return new Response('limited', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  await assert.rejects(client.list('activity', { oldest: '2026-10-01', newest: '2026-10-18' }), e => e.status === 429 && e.retryAfter === 120);
});

test('HTTP client sends only weight:-1 when clearing a numeric wellness field', async () => {
  const client = createIntervalsClient({ apiKey: 'test' }, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://intervals.icu/api/v1/athlete/0/wellness/2026-10-18');
    assert.equal(init.method, 'PUT'); assert.deepEqual(JSON.parse(init.body), { weight: -1 });
    return Response.json({ id: '2026-10-18', weight: null });
  } });
  await client.remove('weight', '2026-10-18');
});

test('a stale reviewed snapshot cannot authorize deletion after a refreshed conflict', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.state.workouts[0].name = 'Local edit'; h.remote.activities[0].name = 'Remote edit';
  await h.sync.run('u');
  const old = h.sync.status('u').conflicts[0];
  h.state.workouts = []; await h.sync.run('u');
  const fresh = h.sync.status('u').conflicts[0], calls = h.remote.calls.length;
  await assert.rejects(h.sync.resolve('u', old.id, 'local', old.token), e => e.status === 409);
  assert.equal(h.remote.calls.length, calls);
  assert.equal(h.remote.activities.length, 1);
  await assert.rejects(h.sync.resolve('u', fresh.id, 'local'), e => e.status === 409);
  await h.sync.resolve('u', fresh.id, 'local', fresh.token);
  assert.equal(h.remote.activities.length, 0);
});

test('a choice still rechecks source snapshots after it is submitted', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.state.workouts[0].name = 'Local edit'; h.remote.activities[0].name = 'Remote edit';
  await h.sync.run('u'); const old = h.sync.status('u').conflicts[0];
  h.state.workouts = [];
  await h.sync.resolve('u', old.id, 'local', old.token);
  assert.equal(h.remote.activities.length, 1);
  assert.equal(h.sync.status('u').conflicts[0].local, null);
});

test('conflict tokens survive unchanged polling but cannot be reused after reconnect', async t => {
  const h = harness(t); await connect(h); await h.sync.run('u');
  h.state.workouts[0].name = 'Local edit'; h.remote.activities[0].name = 'Remote edit';
  await h.sync.run('u'); const old = h.sync.status('u').conflicts[0];
  assert.equal(typeof old.token, 'string');
  await h.sync.run('u'); assert.equal(h.sync.status('u').conflicts[0].token, old.token);
  await connect(h); await h.sync.run('u'); const fresh = h.sync.status('u').conflicts[0];
  assert.notEqual(fresh.token, old.token);
  const calls = h.remote.calls.length;
  await assert.rejects(h.sync.resolve('u', old.id, 'remote', old.token), e => e.status === 409);
  assert.equal(h.remote.calls.length, calls);
  assert.equal(h.state.workouts[0].name, 'Local edit');
  await h.sync.resolve('u', fresh.id, 'remote', fresh.token);
  assert.equal(h.state.workouts[0].name, 'Remote edit');
});
