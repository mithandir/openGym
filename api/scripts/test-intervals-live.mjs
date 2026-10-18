// Opt-in live verification. Requires a disposable localhost OpenGym profile already
// connected through Settings. Credentials are read from its encrypted integration file,
// never accepted on the command line or included in output. Run from the repository root:
// node api/scripts/test-intervals-live.mjs http://127.0.0.1:3000 <session.json> <test-data-dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createIntervalsClient } from '../intervals-client.js';
import { addDays, dayAt, externalId, instant } from '../intervals-model.js';

const [base, sessionFile, dataDir] = process.argv.slice(2);
if (!base || !sessionFile || !dataDir) throw new Error('Usage: test-intervals-live.mjs <localhost-api-url> <session.json> <disposable-data-dir>');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname) || !/^opengym-intervals-live-[a-f0-9]{32}$/.test(path.basename(dataDir))) throw new Error('Live tests require an isolated localhost OpenGym server and disposable test data directory.');
const { uid, cookie } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
if (!db.users.some(u => u.id === uid && u.name.startsWith('OpenGym live test'))) throw new Error('Refusing to use a non-test OpenGym profile.');
const integrationFile = path.join(dataDir, `intervals-${uid}.json`);
if (!fs.existsSync(integrationFile)) throw new Error('Connect Intervals.icu in the disposable OpenGym profile first.');
const connection = JSON.parse(fs.readFileSync(integrationFile, 'utf8'));
const secret = fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim();
const key = crypto.createHash('sha256').update('opengym-intervals-v1:' + secret).digest();
const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(connection.auth.iv, 'base64'));
decipher.setAuthTag(Buffer.from(connection.auth.tag, 'base64'));
const auth = JSON.parse(Buffer.concat([decipher.update(Buffer.from(connection.auth.data, 'base64')), decipher.final()]).toString('utf8'));
const remote = createIntervalsClient(auth);
const id = crypto.randomUUID(), prefix = `OpenGym LIVE TEST ${id.slice(0, 8)}`;
const today = dayAt(Date.now(), 'Europe/Zurich');
const result = { run: id, started: new Date().toISOString(), checks: [], cleanup: [] };
const resultFile = path.join(dataDir, 'live-test-result.json');
const persist = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
const pass = name => { result.checks.push({ name, passed: true }); persist(); console.log('PASS', name); };
const headers = { Cookie: cookie, Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' };
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const data = await r.json();
  if (!r.ok) throw new Error(`OpenGym ${method} ${route}: ${r.status} ${data.error || ''}`);
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function idle() {
  for (let i = 0; i < 300; i++) {
    const status = await api('/api/intervals/status');
    if (!status.running) return status;
    await sleep(300);
  }
  throw new Error('OpenGym sync did not finish within 90 seconds.');
}
async function sync() {
  await idle(); await api('/api/intervals/sync', 'POST');
  const status = await idle();
  if (status.error) throw new Error(status.error);
  return status;
}
async function change(mutate) {
  const { state, rev } = await api('/api/data');
  mutate(state);
  await api('/api/data', 'PUT', { state, baseRev: rev, baseWid: state._wid });
}
const getState = async () => (await api('/api/data')).state;
const owned = { activity: new Set(), plan: new Set() };
const remember = (kind, value) => { assert.ok(value.id != null, `Live API did not return the ${kind} record`); owned[kind].add(String(value.id)); result[`${kind}Ids`] = [...owned[kind]]; persist(); return value; };
const ext = {
  activity: externalId(uid, 'activity', id + '-workout'),
  plan: null,
  nativeActivity: `opengym-live:${id}:native-activity`,
  nativePlan: `opengym-live:${id}:native-plan`,
};
const touchedWeights = new Map();
let originalOptions, testDates, localWorkout;
try {
  const initialStatus = await idle(); assert.equal(initialStatus.connected, true);
  originalOptions = initialStatus.options;
  await api('/api/intervals/settings', 'PUT', { ...originalOptions, enabled: false, historyDays: 90, futureDays: 180, timezone: 'Europe/Zurich' });
  const wellness = await remote.list('weight', { oldest: addDays(today, -90), newest: today });
  const availableWeights = Array.from({ length: 89 }, (_, i) => addDays(today, -i - 1)).filter(d => !wellness.some(w => w.id === d && w.weight != null));
  assert.ok(availableWeights.length >= 2, 'Need two dates without existing body-weight data; existing weights will not be overwritten.');
  const events = await remote.list('plan', { oldest: today, newest: addDays(today, 180) });
  const freeDates = Array.from({ length: 179 }, (_, i) => addDays(today, i + 1)).filter(d => !events.some(e => e.type === 'WeightTraining' && e.start_date_local?.startsWith(d)));
  assert.ok(freeDates.length >= 3, 'Need three dates without existing gym plans.');
  testDates = { weight: availableWeights[0], nativeWeight: availableWeights[1], plan: freeDates[0], movedPlan: freeDates[1], nativePlan: freeDates[2] };
  ext.plan = externalId(uid, 'plan', testDates.plan);
  for (const date of [testDates.weight, testDates.nativeWeight]) touchedWeights.set(date, wellness.find(w => w.id === date)?.weight ?? null);
  result.dates = testDates; persist();
  const start = instant(addDays(today, -1), '12:34:00', 'Europe/Zurich');
  localWorkout = { id: id + '-workout', d: addDays(today, -1), name: prefix + ' exported workout', note: 'Disposable live API verification', start, end: start + 1800000, entries: [{ id: '0001', sets: [{ w: 20, r: 5, done: true }] }], prs: [], routineIds: [] };
  await change(S => {
    S.workouts ||= []; S.workouts.push(localWorkout);
    S.bodyweight ||= []; S.bodyweight.push({ d: testDates.weight, w: 76.321, t: Date.now() });
    S.routines ||= []; S.routines.push({ id: id + '-routine', name: prefix + ' exported plan', note: 'Disposable live plan', ex: [{ id: '0001', sets: 2, reps: 5, weight: 20 }], prog: 'off' });
    S.dayPlan ||= {}; S.dayPlan[testDates.plan] = id + '-routine';
  });
  await sync();
  let activities = await remote.list('activity', { oldest: addDays(today, -2), newest: today });
  let plans = await remote.list('plan', { oldest: today, newest: addDays(today, 180) });
  let activity = remember('activity', activities.find(a => a.external_id === ext.activity) || {});
  let plan = remember('plan', plans.find(e => e.external_id === ext.plan) || {});
  assert.ok(activity.id && plan.id, 'Both exported records must be visible through the live API.');
  assert.equal(activity.name, localWorkout.name); assert.equal((await remote.get('weight', testDates.weight)).weight, 76.321);
  pass('OpenGym exports workout, weight, and dated plan to the live API');
  await sync();
  activities = await remote.list('activity', { oldest: addDays(today, -2), newest: today });
  plans = await remote.list('plan', { oldest: today, newest: addDays(today, 180) });
  assert.equal(activities.filter(a => a.external_id === ext.activity).length, 1); assert.equal(plans.filter(e => e.external_id === ext.plan).length, 1);
  pass('Repeated sync does not create duplicates');
  const remoteName = prefix + ' remote edit';
  await remote.put('activity', { date: localWorkout.d, time: '12:34:00', name: remoteName, description: 'Edited through the real Intervals API', seconds: 2100 }, { id: activity.id });
  await remote.put('weight', { date: testDates.weight, weight: 76.821 });
  await remote.put('plan', { date: testDates.movedPlan, time: '17:00:00', name: prefix + ' moved remotely', description: 'Moved through the live API', seconds: 1800 }, { id: plan.id });
  await sync();
  let S = await getState(), w = S.workouts.find(w => w.id === localWorkout.id);
  assert.equal(w.name, remoteName); assert.deepEqual(w.entries, localWorkout.entries);
  assert.equal(S.bodyweight.find(w => w.d === testDates.weight).w, 76.821);
  assert.equal(S.dayPlan[testDates.plan], 'rest');
  assert.equal(S.routines.find(r => r.id === S.dayPlan[testDates.movedPlan]).name, prefix + ' moved remotely');
  assert.equal(S.routines.find(r => r.id === id + '-routine').name, prefix + ' exported plan');
  pass('Remote edits import while preserving detailed sets and recurring source routines');
  const nativeActivity = remember('activity', await remote.put('activity', { date: addDays(today, -1), time: '13:34:00', name: prefix + ' native workout', description: 'Native remote summary', seconds: 900 }, { externalId: ext.nativeActivity }));
  const nativePlan = remember('plan', await remote.put('plan', { date: testDates.nativePlan, time: '18:00:00', name: prefix + ' native plan', description: 'Squat 3 x 5. Test summary, not a prescription.', seconds: 1200 }, { externalId: ext.nativePlan }));
  await remote.put('weight', { date: testDates.nativeWeight, weight: 75.123 });
  await sync(); S = await getState();
  const imported = S.workouts.find(w => w.name === prefix + ' native workout'); assert.ok(imported); assert.deepEqual(imported.entries, []); assert.equal(imported.excludeFromProgression, true);
  assert.equal(S.bodyweight.find(w => w.d === testDates.nativeWeight).w, 75.123);
  const importedPlan = S.routines.find(r => r.id === S.dayPlan[testDates.nativePlan]); assert.ok(importedPlan?.intervalsPlan.needsReview);
  pass('Native Intervals workout, weight, and planned session import into OpenGym');
  await api('/api/intervals/settings', 'PUT', { enabled: true });
  await change(S => { S.workouts.find(w => w.id === localWorkout.id).name = prefix + ' automatic push'; });
  let automatic = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000); const status = await api('/api/intervals/status');
    if (status.error) throw new Error(status.error);
    if (!status.running && (await remote.get('activity', activity.id))?.name === prefix + ' automatic push') { automatic = true; break; }
  }
  assert.ok(automatic, 'After-write automatic polling should update the remote workout without Sync now.');
  await idle(); await api('/api/intervals/settings', 'PUT', { enabled: false });
  pass('Automatic after-write polling updates the live activity without manual sync');
  await change(S => { S.workouts.find(w => w.id === localWorkout.id).name = prefix + ' local conflict'; });
  await remote.put('activity', { date: localWorkout.d, time: '12:34:00', name: prefix + ' remote conflict', description: 'Edited through the real Intervals API', seconds: 2100 }, { id: activity.id });
  let status = await sync();
  const conflict = status.conflicts.find(c => c.kind === 'activity' && c.key === localWorkout.id); assert.ok(conflict);
  assert.equal((await getState()).workouts.find(w => w.id === localWorkout.id).name, prefix + ' local conflict');
  await api('/api/intervals/resolve', 'POST', { id: conflict.id, choice: 'remote', token: conflict.token });
  assert.equal((await getState()).workouts.find(w => w.id === localWorkout.id).name, prefix + ' remote conflict');
  pass('Conflicting live edits wait for review and apply the selected side');
  await remote.remove('plan', plan.id); status = await sync();
  const deletion = status.conflicts.find(c => c.kind === 'plan' && c.remote === null && c.local?.name === prefix + ' moved remotely'); assert.ok(deletion);
  assert.notEqual((await getState()).dayPlan[testDates.movedPlan], 'rest');
  await api('/api/intervals/resolve', 'POST', { id: deletion.id, choice: 'remote', token: deletion.token });
  assert.equal((await getState()).dayPlan[testDates.movedPlan], 'rest');
  pass('A live remote deletion is held for review before cancelling its OpenGym date');
  await remote.remove('activity', activity.id); status = await sync();
  const restore = status.conflicts.find(c => c.kind === 'activity' && c.key === localWorkout.id && c.remote === null); assert.ok(restore);
  await api('/api/intervals/resolve', 'POST', { id: restore.id, choice: 'local', token: restore.token });
  activities = await remote.list('activity', { oldest: addDays(today, -2), newest: today });
  activity = remember('activity', activities.find(a => a.external_id === ext.activity) || {}); assert.ok(activity.id);
  pass('Choosing the surviving OpenGym version restores a deleted live activity');
  const beforeWeightDeletion = await remote.get('weight', testDates.weight);
  await change(S => { S.bodyweight = S.bodyweight.filter(w => w.d !== testDates.weight); });
  status = await sync();
  const weightDeletion = status.conflicts.find(c => c.kind === 'weight' && c.key === testDates.weight && c.local === null); assert.ok(weightDeletion);
  await api('/api/intervals/resolve', 'POST', { id: weightDeletion.id, choice: 'local', token: weightDeletion.token });
  const afterWeightDeletion = await remote.get('weight', testDates.weight);
  assert.equal(afterWeightDeletion.weight, null);
  for (const [field, value] of Object.entries(beforeWeightDeletion)) if (!['updated', 'weight', 'tempWeight'].includes(field)) assert.deepEqual(afterWeightDeletion[field], value, `Unrelated wellness field ${field} must be preserved`);
  pass('Confirmed weigh-in deletion clears the live weight and preserves unrelated wellness fields');
  result.passed = true;
} catch (e) {
  result.passed = false; result.error = e.message; console.error('FAIL', e.message); process.exitCode = 1;
} finally {
  try { await idle(); await api('/api/intervals/settings', 'PUT', { enabled: false }); }
  catch (e) { result.cleanup.push({ name: 'pause automatic sync', error: e.message }); }
  // Rediscover by the exact external IDs in case the server saved a write whose response
  // was interrupted. Never select records by date or name alone for deletion.
  for (const kind of ['activity', 'plan']) {
    try {
      const list = await remote.list(kind, { oldest: kind === 'activity' ? addDays(today, -3) : today, newest: kind === 'activity' ? today : addDays(today, 180) });
      for (const record of list) if ([ext[kind], ext[kind === 'activity' ? 'nativeActivity' : 'nativePlan']].filter(Boolean).includes(record.external_id)) remember(kind, record);
      for (const recordId of owned[kind]) {
        try { await remote.remove(kind, recordId); } catch (e) { if (e.status !== 404) throw e; }
      }
      result.cleanup.push({ name: `${kind} records removed`, count: owned[kind].size });
    } catch (e) { result.cleanup.push({ name: `${kind} cleanup`, error: e.message }); process.exitCode = 1; }
  }
  for (const [date, weight] of touchedWeights) {
    try {
      if (weight == null) await remote.remove('weight', date); else await remote.put('weight', { date, weight });
      assert.equal((await remote.get('weight', date))?.weight ?? null, weight);
      result.cleanup.push({ name: 'wellness weight restored', date });
    } catch (e) { result.cleanup.push({ name: 'wellness cleanup', date, error: e.message }); process.exitCode = 1; }
  }
  try { await api('/api/intervals/connect', 'DELETE'); result.cleanup.push({ name: 'OpenGym credentials disconnected' }); }
  catch (e) { result.cleanup.push({ name: 'disconnect', error: e.message }); process.exitCode = 1; }
  result.finished = new Date().toISOString(); persist();
  console.log('Live verification report:', resultFile);
  console.log('Successful checks:', result.checks.length, 'Cleanup errors:', result.cleanup.filter(c => c.error).length);
}
