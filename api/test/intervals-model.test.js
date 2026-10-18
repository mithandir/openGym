import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRecords, remoteRecord, applyRecord, decision, rangeFor } from '../intervals-model.js';

const options = { today: '2026-10-18', historyDays: 90, futureDays: 42, timezone: 'Europe/Zurich' };
const state = () => ({ unit: 'lb', workouts: [], bodyweight: [], routines: [{ id: 'r', name: 'Strength', ex: [{ id: 'squat', sets: 3, reps: 5, weight: 100 }] }], week: { 1: 'r' }, dayPlan: {}, customEx: [{ id: 'squat', n: 'Squat' }] });

test('wellness uses kg and round-trips a pound profile without changing other days', () => {
  const s = state(); s.bodyweight = [{ d: '2026-10-18', w: 220.4622621849 }];
  const r = localRecords(s, options).find(r => r.kind === 'weight');
  assert.ok(Math.abs(r.value.weight - 100) < 0.00001);
  applyRecord(s, 'weight', r.key, { date: r.key, weight: 90 }, 123);
  assert.ok(Math.abs(s.bodyweight[0].w - 198.416035966) < 0.00001);
  assert.equal(s.bodyweight[0].t, 123);
});

test('activity summary edits preserve detailed OpenGym sets and do not manufacture progression', () => {
  const s = state(); const entries = [{ id: 'squat', sets: [{ w: 100, r: 5, done: true }] }];
  s.workouts = [{ id: 'w', d: '2026-10-18', start: Date.parse('2026-10-18T08:00:00Z'), end: Date.parse('2026-10-18T09:00:00Z'), name: 'Gym', entries }];
  const r = localRecords(s, options).find(r => r.kind === 'activity');
  assert.match(r.value.description, /Squat/);
  const changed = { ...r.value, name: 'Edited', description: 'Hard work', seconds: 1800 };
  applyRecord(s, 'activity', r.key, changed, 234, options);
  assert.deepEqual(s.workouts[0].entries, entries);
  assert.deepEqual(localRecords(s, options).find(r => r.kind === 'activity').value, changed);
  applyRecord(s, 'activity', 'new', changed, 235, options);
  assert.deepEqual(s.workouts[1].entries, []);
  assert.equal(s.workouts[1].excludeFromProgression, true);
});

test('fixed-week dates and combined routines export; unpinned rotations do not repeat', () => {
  const s = state();
  const plans = localRecords(s, options).filter(r => r.kind === 'plan');
  assert.equal(plans.length, 6);
  assert.equal(plans[0].value.date, '2026-10-19');
  s.queue = { ids: ['r'], since: 1, startsOn: '2026-10-18' };
  assert.equal(localRecords(s, options).filter(r => r.kind === 'plan').length, 0);
  s.dayPlan['2026-10-20'] = 'r';
  assert.equal(localRecords(s, options).filter(r => r.kind === 'plan').length, 1);
});

test('remote plan moves create an isolated dated routine and cancel the previous day', () => {
  const s = state();
  const p = localRecords(s, options).find(r => r.kind === 'plan');
  applyRecord(s, 'plan', p.key, { ...p.value, date: '2026-10-20', name: 'Moved' }, 100);
  assert.equal(s.routines[0].name, 'Strength');
  assert.equal(s.dayPlan['2026-10-19'], 'rest');
  const moved = localRecords(s, options).filter(r => r.kind === 'plan' && r.key === p.key);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].value.date, '2026-10-20');
  assert.equal(s.routines.find(r => r.id === s.dayPlan['2026-10-20']).ex.length, 1);
  applyRecord(s, 'plan', p.key, null, 200);
  assert.equal(s.dayPlan['2026-10-20'], 'rest');
});

test('remote gym imports retain descriptions, skip other sports and Strava stubs', () => {
  assert.equal(remoteRecord('activity', { id: 'a' }), null);
  assert.equal(remoteRecord('activity', { id: 'a', type: 'Run' }), null);
  const r = remoteRecord('plan', { id: 2, type: 'WeightTraining', category: 'WORKOUT', name: 'Gym', start_date_local: '2026-10-20T17:30:00', description: 'Squat 3 x 5' });
  const s = state(); applyRecord(s, 'plan', 'remote:2', r, 300);
  const routine = s.routines.find(r => r.id === s.dayPlan['2026-10-20']);
  assert.deepEqual(routine.ex, []);
  assert.equal(routine.note, 'Squat 3 x 5');
  assert.equal(routine.intervalsPlan.needsReview, true);
});

test('three-way comparisons distinguish one-sided edits, conflicts, and deletion review', () => {
  const a = { name: 'A' }, b = { name: 'B' };
  assert.equal(decision(a, a, { local: a, remote: a }), 'same');
  assert.equal(decision(b, a, { local: a, remote: a }), 'push');
  assert.equal(decision(a, b, { local: a, remote: a }), 'pull');
  assert.equal(decision(b, { name: 'C' }, { local: a, remote: a }), 'conflict');
  assert.equal(decision(null, a, { local: a, remote: a }), 'conflict');
  assert.equal(decision(a, b, null), 'conflict');
  assert.equal(decision(null, null, { local: a, remote: a }), 'same');
  assert.deepEqual(rangeFor(options), { oldest: '2026-07-20', newest: '2026-11-29', today: '2026-10-18' });
});

test('a remote rename followed by editing sets does not export stale generated set lines as notes', () => {
  const s = state(); s.unit = 'kg';
  s.workouts = [{ id: 'w', d: '2026-10-18', name: 'Gym', note: 'Felt good', start: Date.parse('2026-10-18T08:00:00Z'), end: Date.parse('2026-10-18T09:00:00Z'), entries: [{ id: 'squat', sets: [{ w: 50, r: 5, done: true }] }] }];
  const first = localRecords(s, options).find(r => r.kind === 'activity');
  applyRecord(s, 'activity', first.key, { ...first.value, name: 'Renamed' }, 400, options);
  assert.equal(s.workouts[0].note, 'Felt good');
  s.workouts[0].entries[0].sets[0].w = 60;
  const next = localRecords(s, options).find(r => r.kind === 'activity');
  assert.match(next.value.description, /60 kg/); assert.doesNotMatch(next.value.description, /50 kg/);
});

test('a remote planned-session rename preserves authored notes before prescription edits', () => {
  const s = state(); const first = localRecords(s, options).find(r => r.kind === 'plan');
  applyRecord(s, 'plan', first.key, { ...first.value, name: 'Renamed' }, 500, options);
  const routine = s.routines.find(r => r.id === s.dayPlan[first.value.date]);
  assert.equal(routine.note, '');
  routine.ex[0].reps = 8;
  const next = localRecords(s, options).find(r => r.kind === 'plan' && r.key === first.key);
  assert.match(next.value.description, /8 reps/); assert.doesNotMatch(next.value.description, /5 reps/);
});

test('completed workouts export persisted custom exercise names', () => {
  const s = state(); s.unit = 'kg';
  s.customEx = [{ id: 'custom-123', n: 'Sandbag carry' }];
  s.workouts = [{ id: 'w', d: '2026-10-18', name: 'Gym', entries: [{ id: 'custom-123', sets: [{ w: 20, sec: 30, done: true }] }] }];
  const activity = localRecords(s, options).find(r => r.kind === 'activity');
  assert.equal(activity.value.description, 'Sandbag carry: 30s @ 20 kg');
});

test('planned prescriptions export persisted custom exercise names', () => {
  const s = state(); s.unit = 'kg';
  s.customEx = [{ id: 'custom-123', n: 'Sandbag carry' }];
  s.routines[0].ex = [{ id: 'custom-123', sets: 3, mode: 'time', sec: 30, weight: 20 }];
  const plan = localRecords(s, options).find(r => r.kind === 'plan');
  assert.equal(plan.value.description, 'Sandbag carry: 3 × 30s @ 20 kg');
});

test('custom exercise names retain compatibility and missing-name fallbacks', () => {
  const s = state();
  s.customEx = [{ id: 'legacy-custom', name: 'Legacy carry' }, { id: 'unnamed-custom', n: '', name: '' }];
  s.routines[0].ex = [
    { id: 'legacy-custom', sets: 1, reps: 5 },
    { id: 'unnamed-custom', name: 'Logged carry', sets: 1, reps: 5 },
    { id: 'missing-custom', sets: 1, reps: 5 },
  ];
  const plan = localRecords(s, options).find(r => r.kind === 'plan');
  assert.equal(plan.value.description, 'Legacy carry: 1 × 5 reps\nLogged carry: 1 × 5 reps\nmissing-custom: 1 × 5 reps');
});
test('remote metadata edits preserve single-source training settings and detailed prescriptions', () => {
  const s = state();
  Object.assign(s.routines[0], { prog: 'double', excludeFromProgression: true, emoji: '💪' });
  Object.assign(s.routines[0].ex[0], { repsMin: 3, inc: 1.25, warmupSets: 2, intensifier: { type: 'dropset', percent: 20 } });
  const original = structuredClone(s.routines[0]);
  const p = localRecords(s, options).find(r => r.kind === 'plan');
  for (const name of ['Renamed', 'Renamed again']) {
    applyRecord(s, 'plan', p.key, { ...p.value, name }, 600, options);
    const copy = s.routines.find(r => r.id === s.dayPlan[p.value.date]);
    assert.equal(copy.prog, 'double');
    assert.equal(copy.excludeFromProgression, true);
    assert.deepEqual(copy.ex, original.ex.map(cfg => ({ ...cfg, progressionRoutineId: original.id })));
    assert.deepEqual(s.routines[0], original);
  }
});

test('combined remote plan copies retain each source policy and exclusion independently', () => {
  const s = state();
  s.routines[0].prog = 'double';
  s.routines.push({ id: 'rehab', name: 'Rehab', prog: 'linear', excludeFromProgression: true, ex: [{ id: 'curl', sets: 2, reps: 12, weight: 5, prog: 'off' }] });
  s.week[1] = ['r', 'rehab'];
  const originals = structuredClone(s.routines);
  const p = localRecords(s, options).find(r => r.kind === 'plan');
  for (const name of ['Combined', 'Combined again']) {
    applyRecord(s, 'plan', p.key, { ...p.value, name }, 700, options);
    const copy = s.routines.find(r => r.id === s.dayPlan[p.value.date]);
    assert.equal(copy.ex[0].prog, 'double');
    assert.notEqual(copy.ex[0].excludeFromProgression, true);
    assert.equal(copy.ex[1].prog, 'off');
    assert.equal(copy.ex[1].excludeFromProgression, true);
    assert.notEqual(copy.excludeFromProgression, true);
    assert.deepEqual(s.routines.slice(0, 2), originals);
  }
});

test('remote copies retain implicit progression defaults and native plans keep progression off', () => {
  const s = state();
  const p = localRecords(s, options).find(r => r.kind === 'plan');
  applyRecord(s, 'plan', p.key, { ...p.value, name: 'Default policy' }, 800, options);
  assert.equal(s.routines.find(r => r.id === s.dayPlan[p.value.date]).prog, undefined);
  applyRecord(s, 'plan', 'remote:summary', { ...p.value, date: '2026-10-20', description: 'Summary only' }, 801, options);
  const native = s.routines.find(r => r.id === s.dayPlan['2026-10-20']);
  assert.equal(native.prog, 'off');
  assert.deepEqual(native.ex, []);
});

test('unilateral summaries export only completed timed sides with their recorded units and loads', () => {
  const s = state(); s.unit = 'kg';
  s.workouts = [{ id: 'w', d: '2026-10-18', entries: [{ id: 'squat', sets: [
    { sides: { L: { sec: 30, w: 10, done: true }, R: { sec: 45, w: 20, done: false } } },
    { sides: { L: { min: 2, w: 5, done: false }, R: { min: 3, w: 7.5, done: true } } },
    { done: true, sides: { L: { sec: 20, w: 8, done: true }, R: { min: 1, w: 9, done: true } } },
    { sides: { L: { sec: 60, done: false }, R: { sec: 60, done: false } } },
  ] }] }];
  const activity = localRecords(s, options).find(r => r.kind === 'activity');
  assert.equal(activity.value.description, 'Squat: L: 30s @ 10 kg; R: 3min @ 7.5 kg; L: 20s @ 8 kg, R: 1min @ 9 kg');
});

test('unilateral rep summaries omit unfinished sides and convert each completed side load from pounds', () => {
  const s = state();
  s.workouts = [{ id: 'w', d: '2026-10-18', entries: [{ id: 'squat', sets: [
    { sides: { L: { r: 5, w: 10, done: true }, R: { r: 8, w: 20, done: false } } },
    { sides: { L: { r: 10, w: 30, done: false }, R: { r: 6, w: 15, done: true } } },
    { done: true, sides: { L: { r: 7, w: 20, done: true }, R: { r: 8, w: 25, done: true } } },
  ] }] }];
  const activity = localRecords(s, options).find(r => r.kind === 'activity');
  assert.equal(activity.value.description, 'Squat: L: 5 reps @ 4.535924 kg; R: 6 reps @ 6.803886 kg; L: 7 reps @ 9.071847 kg, R: 8 reps @ 11.339809 kg');
});

test('ordinary completed rep and timed summaries retain their existing format', () => {
  const s = state(); s.unit = 'kg';
  s.workouts = [{ id: 'w', d: '2026-10-18', entries: [{ id: 'squat', sets: [
    { r: 5, w: 50, done: true }, { sec: 30, w: 10, done: true },
    { min: 2, done: true }, { r: 8, w: 60, done: false },
  ] }] }];
  const activity = localRecords(s, options).find(r => r.kind === 'activity');
  assert.equal(activity.value.description, 'Squat: 5 reps @ 50 kg; 30s @ 10 kg; 2min');
});
