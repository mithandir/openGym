// Shared fields only: summary edits must never replace a lifter's detailed set history.
import crypto from 'node:crypto';
import { pinState, queueLiveOn } from './queue.js';
import { LIBRARY } from './coach/core/library.js';

export const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const list = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
const round = n => Math.round(n * 1e6) / 1e6;
const kg = (v, unit) => round(Number(v) * (unit === 'lb' ? 0.45359237 : 1));
const inUnit = (v, unit) => round(Number(v) / (unit === 'lb' ? 0.45359237 : 1));
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const text = v => typeof v === 'string' ? v : '';
const names = new Map(LIBRARY.map(e => [e.id, e.n]));
export const stableId = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
export const externalId = (uid, kind, key) => `opengym:${stableId(uid)}:${kind}:${stableId(key)}`;
export function dayAt(now, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date, n) { return new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function clockAt(ms, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function instant(date, time, timezone = 'UTC') {
  const desired = Date.parse(`${date}T${time || '00:00:00'}Z`);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const shown = Date.parse(`${dayAt(guess, timezone)}T${clockAt(guess, timezone)}Z`);
    guess += desired - shown;
  }
  return guess;
}
export function rangeFor({ today = dayAt(Date.now()), historyDays = 90, futureDays = 42 } = {}) {
  return { oldest: addDays(today, -historyDays), newest: addDays(today, futureDays), today };
}
function exerciseName(S, entry) {
  const custom = list(S.customEx).find(e => e.id === entry.id);
  return text(custom?.n) || text(custom?.name) || names.get(entry.id) || text(entry.name) || String(entry.id);
}
function setsText(S, entry, planned) {
  const load = v => v == null ? '' : ` @ ${kg(v, S.unit)} kg`;
  const sets = planned ? [`${num(entry.sets) || 1} × ${entry.mode === 'time' ? `${num(entry.sec)}s` : entry.mode === 'cardio' ? `${num(entry.min)}min` : `${num(entry.reps)} reps`}${load(entry.weight)}`]
    : list(entry.sets).filter(s => s.done || s.sides?.L?.done || s.sides?.R?.done).map(s => {
      if (s.sides) return ['L', 'R'].filter(side => s.sides[side]?.done).map(side => {
        const recorded = s.sides[side];
        return `${side}: ${recorded.min ? `${recorded.min}min` : recorded.sec ? `${recorded.sec}s` : `${num(recorded.r)} reps`}${load(recorded.w)}`;
      }).join(', ');
      return `${s.min ? `${s.min}min` : s.sec ? `${s.sec}s` : `${num(s.r)} reps`}${load(s.w)}`;
    });
  return `${exerciseName(S, entry)}: ${sets.join('; ')}${entry.note ? ` — ${entry.note}` : ''}`;
}
const description = (S, entries, note, planned) => [text(note), ...list(entries).map(e => setsText(S, e, planned))].filter(Boolean).join('\n');
function authoredNote(S, entries, desc, planned) {
  const generated = description(S, entries, '', planned);
  if (generated && desc === generated) return '';
  if (generated && desc.endsWith('\n' + generated)) return desc.slice(0, -generated.length - 1);
  return desc;
}
function value(date, time, name, desc, seconds = 0) {
  return { date, time: time || '00:00:00', name: text(name), description: text(desc), seconds: Math.max(0, Math.round(num(seconds))) };
}
// Match OpenGym's saved work-set volume for legacy sessions without a persisted total.
function completedVolume(set) {
  if (set.sides) return ['L', 'R'].reduce((v, side) => v + completedVolume(set.sides[side] || {}), 0);
  if (!set.done) return 0;
  return num(set.w) * num(set.r) + (set.type === 'dropset' ? list(set.drops).reduce((v, d) => v + num(d.w) * num(d.r), 0) : 0);
}
function liftedWeight(S, w) {
  if (Number.isFinite(w.vol)) return kg(w.vol, S.unit);
  if (!list(w.entries).length && w.intervalsSummary?.weightLifted != null) return w.intervalsSummary.weightLifted;
  const volume = list(w.entries).reduce((total, entry) => {
    const oneArm = entry.target?.side || /\b(one|single)[- ]?(arm|hand|handed)\b/i.test(names.get(entry.id) || '');
    const factor = entry.target?.dbLoad === 'each' && !oneArm ? 2 : 1;
    return total + list(entry.sets).reduce((v, set) => {
      const phase = typeof set.phase === 'string' && set.phase ? set.phase.trim().toLowerCase() : set.warmup === true ? 'warmup' : 'work';
      return v + (['warmup', 'warm-up', 'warm_up'].includes(phase) ? 0 : completedVolume(set) * factor);
    }, 0);
  }, 0);
  return kg(volume, S.unit);
}
function workoutValue(S, w, timezone) {
  const detailed = description(S, w.entries, w.note, false);
  // Remote prose remains editable in History. Rebuild from sets only when the sets or note change.
  const kept = w.intervalsSummary;
  const desc = kept && equal(kept.entries, w.entries) && kept.note === (w.note || '') ? kept.description : detailed;
  return { ...value(w.d, w.start ? clockAt(w.start, timezone) : '00:00:00', w.name, desc, (num(w.end) - num(w.start)) / 1000), weightLifted: liftedWeight(S, w) };
}
function planRoutines(S, date) {
  const routines = list(S.routines), ov = S.dayPlan?.[date];
  if (ov === 'rest') return [];
  if (ov && routines.some(r => r.id === ov) && !pinState(S, ov)) return routines.filter(r => r.id === ov);
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  const ids = [].concat(S.week?.[wd] || []);
  const live = queueLiveOn(S, date);
  const pinned = pinState(S, ov) === 'open' ? ov : null;
  // A floating session has no stable calendar date. Publish only explicit pins.
  return [...new Set([...(pinned ? [pinned] : []), ...ids.filter(id => !(live && S.queue.ids.includes(id)))])]
    .map(id => routines.find(r => r.id === id)).filter(Boolean);
}
export function localRecords(S, options = {}) {
  if (!S) return [];
  const { oldest, newest, today } = rangeFor(options), timezone = options.timezone || 'UTC';
  const records = [];
  for (const w of list(S.workouts)) if (w.id && w.d >= oldest && w.d <= today) records.push({ kind: 'activity', key: String(w.id), value: workoutValue(S, w, timezone) });
  for (const b of list(S.bodyweight)) if (b.d >= oldest && b.d <= today && num(b.w) > 0) records.push({ kind: 'weight', key: b.d, value: { date: b.d, weight: kg(b.w, S.unit) } });
  for (let date = today; date < newest; date = addDays(date, 1)) {
    const routines = planRoutines(S, date);
    if (!routines.length) continue;
    const tagged = routines.length === 1 ? routines[0].intervalsPlan : null;
    const desc = tagged && tagged.source === description(S, routines[0].ex, routines[0].note, true)
      ? tagged.description : description(S, routines.flatMap(r => r.ex || []), routines.map(r => r.note || '').filter(Boolean).join('\n'), true);
    records.push({ kind: 'plan', key: tagged?.key || date, value: value(date, tagged?.time, routines.map(r => r.name).join(' + '), desc, tagged?.seconds), routines });
  }
  return records;
}
export function remoteRecord(kind, r) {
  if (!r) return null;
  if (kind === 'weight') return num(r.weight) > 0 ? { date: r.id, weight: round(num(r.weight)) } : null;
  if (r.type !== 'WeightTraining' || (kind === 'plan' && r.category !== 'WORKOUT')) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d\d:\d\d/.test(r.start_date_local || '')) return null;
  return { ...value(r.start_date_local.slice(0, 10), r.start_date_local.slice(11, 19).padEnd(8, ':00'), r.name, r.description, r.elapsed_time ?? r.moving_time), ...(kind === 'activity' && r.kg_lifted != null ? { weightLifted: round(num(r.kg_lifted)) } : {}) };
}
export function payloadFor(kind, v, ext) {
  if (kind === 'weight') return { id: v.date, weight: v.weight };
  return {
    name: v.name, description: v.description, type: 'WeightTraining', start_date_local: `${v.date}T${v.time}`,
    ...(kind === 'plan' ? { category: 'WORKOUT', moving_time: v.seconds } : { elapsed_time: v.seconds, moving_time: v.seconds, ...(v.weightLifted != null ? { kg_lifted: v.weightLifted } : {}) }),
    ...(ext ? { external_id: ext } : {}),
  };
}
export function decision(local, remote, baseline) {
  if (equal(local, remote)) return 'same';
  if (!baseline) return !local ? 'pull' : !remote ? 'push' : 'conflict';
  // A disappearance is always reviewed, even if the other side is unchanged.
  if (!local || !remote) return 'conflict';
  const l = !equal(local, baseline.local), r = !equal(remote, baseline.remote);
  return l && r ? 'conflict' : l ? 'push' : r ? 'pull' : 'same';
}
export function applyRecord(S, kind, key, v, now, options = {}) {
  if (kind === 'weight') {
    S.bodyweight = list(S.bodyweight).filter(b => b.d !== key);
    if (v) S.bodyweight.push({ d: v.date, w: inUnit(v.weight, S.unit), t: now });
    S.bodyweight.sort((a, b) => a.d.localeCompare(b.d));
    return;
  }
  if (kind === 'activity') {
    const old = list(S.workouts).find(w => String(w.id) === key);
    S.workouts = list(S.workouts).filter(w => String(w.id) !== key);
    if (v) {
      const start = instant(v.date, v.time, options.timezone);
      const w = { ...(old || { id: key, entries: [], prs: [], routineIds: [], excludeFromProgression: true }), d: v.date, name: v.name, note: authoredNote(S, old?.entries, v.description, false), start, end: start + v.seconds * 1000, _ts: now };
      w.intervalsSummary = { weightLifted: v.weightLifted, description: v.description, note: w.note, entries: structuredClone(w.entries) };
      S.workouts.push(w);
      S.workouts.sort((a, b) => (a.start || 0) - (b.start || 0));
    }
    return;
  }
  const current = localRecords(S, options).find(r => r.kind === 'plan' && (r.key === key || r.value.date === options.linkedDate));
  const id = 'intervals-plan-' + stableId(key);
  const existing = list(S.routines).find(r => r.id === id);
  const previousDate = current?.value.date || (existing && Object.entries(S.dayPlan || {}).find(([, rid]) => rid === existing.id)?.[0]) || existing?.intervalsPlan?.date;
  S.dayPlan ||= {};
  if (previousDate && previousDate !== v?.date) S.dayPlan[previousDate] = 'rest';
  if (!v) { if (previousDate) S.dayPlan[previousDate] = 'rest'; return; }
  // Copy the prescription only for an existing OpenGym plan. Native Intervals prose is kept
  // as a reviewable note, never guessed into a prescription that affects progression.
  const sources = current?.routines || (existing ? [existing] : []);
  // A single source keeps its default policy (including the implicit mode default). When
  // combining sources, freeze each routine's defaults on its copied exercises instead.
  const settings = sources.length === 1 ? sources[0] : sources.length ? {} : { prog: 'off' };
  const ex = structuredClone(sources.flatMap(r => (r.ex || []).map(cfg => ({
    ...cfg,
    // The dated copy is still the source's training session, including when several sources
    // prescribe the same exercise. Keep this identity across further metadata edits/copies.
    progressionRoutineId: cfg.progressionRoutineId || r.id,
    ...(sources.length > 1 && (cfg.prog || r.prog) ? { prog: cfg.prog || r.prog } : {}),
    ...(sources.length > 1 && r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
  }))));
  const routine = { emoji: '🏋️', ...settings, id, name: v.name, ex, note: authoredNote(S, ex, v.description, true), _ts: now };
  routine.intervalsPlan = { key, date: v.date, time: v.time, seconds: v.seconds, description: v.description, needsReview: !ex.length, source: description(S, ex, routine.note, true) };
  S.routines = [...list(S.routines).filter(r => r.id !== id), routine];
  S.dayPlan[v.date] = id;
}
