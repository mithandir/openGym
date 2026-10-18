import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './durable.js';
import { createIntervalsClient, IntervalsError } from './intervals-client.js';
import { localRecords, remoteRecord, decision, equal, externalId, stableId, dayAt, rangeFor, applyRecord } from './intervals-model.js';

export const POLL_MS = 15 * 60000;
export function syncOptions(input = {}) {
  const result = {};
  for (const [key, fallback, max] of [['historyDays', 90, 3650], ['futureDays', 42, 180]]) {
    const n = input[key] ?? fallback;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new IntervalsError(`Invalid ${key}.`, 400);
    result[key] = n;
  }
  result.timezone = input.timezone || 'UTC';
  try { dayAt(Date.now(), result.timezone); } catch { throw new IntervalsError('Invalid timezone.', 400); }
  if (input.enabled != null && typeof input.enabled !== 'boolean') throw new IntervalsError('Invalid automatic sync setting.', 400);
  result.enabled = input.enabled !== false;
  return result;
}
export function createIntervalsSync({ dataDir, secret, readState, writeState, userExists = () => true, fetchImpl, now = Date.now }) {
  const key = crypto.createHash('sha256').update('opengym-intervals-v1:' + secret).digest();
  const running = new Map(), timers = new Map(), connecting = new Map();
  const filename = uid => {
    if (!/^[a-zA-Z0-9_-]+$/.test(uid)) throw new IntervalsError('Invalid user.', 400);
    return path.join(dataDir, `intervals-${uid}.json`);
  };
  function read(uid) {
    try { return JSON.parse(fs.readFileSync(filename(uid), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new IntervalsError('Intervals.icu settings could not be read. Restore the integration file from backup.', 503); }
  }
  const save = (uid, doc) => atomicWrite(filename(uid), JSON.stringify(doc), 0o600);
  function seal(auth) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(auth), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  function unseal(auth) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(auth.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(auth.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(auth.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw new IntervalsError('Intervals.icu credentials could not be decrypted. Reconnect the integration.', 503); }
  }
  const clientFor = doc => createIntervalsClient(unseal(doc.auth), { fetchImpl });
  const current = (uid, doc) => userExists(uid) && read(uid)?.generation === doc.generation;
  function state(uid) { const S = readState(uid); if (!S || typeof S !== 'object') throw new IntervalsError('Sync your OpenGym profile to the server first.', 409); return S; }
  const options = doc => ({ ...doc.options, today: dayAt(now(), doc.options.timezone) });
  function planKey(r, doc, records) {
    if (r.kind !== 'plan' || doc.links[`plan:${r.key}`]) return r.key;
    // Replacing the routine on an imported plan's day edits that same dated event. It must
    // neither create a duplicate event nor treat the prior prescription as a deletion.
    return Object.values(doc.links).find(l => l.kind === 'plan' && l.local?.date === r.value.date
      && !records.some(other => other.kind === 'plan' && other.key === l.key))?.key || r.key;
  }
  function local(uid, kind, id, doc, baseline) {
    const S = state(uid), opt = options(doc);
    // The linked record may have moved out of the configured range. It still exists locally.
    if (kind === 'activity') {
      const w = S.workouts?.find(w => String(w.id) === id);
      if (!w) return null;
      return localRecords({ ...S, routines: [] }, { ...opt, today: w.d, historyDays: 1, futureDays: 1 }).find(r => r.kind === kind && r.key === id)?.value || null;
    }
    if (kind === 'weight') return localRecords({ ...S, routines: [] }, { ...opt, today: id, historyDays: 1, futureDays: 1 }).find(r => r.kind === kind && r.key === id)?.value || null;
    const routine = S.routines?.find(r => r.intervalsPlan?.key === id);
    const assigned = routine && Object.entries(S.dayPlan || {}).find(([, rid]) => rid === routine.id)?.[0];
    const date = assigned || baseline?.date || routine?.intervalsPlan?.date || id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const records = localRecords(S, { ...opt, today: date, historyDays: 1, futureDays: 1 });
    return records.find(r => r.kind === kind && planKey(r, doc, records) === id)?.value || null;
  }
  // Bind the submitted choice to the exact reviewed content and connection. Repeated
  // polls of unchanged content keep the token valid; reconnecting always invalidates it.
  const conflictToken = (uid, doc, conflict) => crypto.createHmac('sha256', key)
    .update(JSON.stringify([uid, doc.generation, conflict.id, conflict.local, conflict.remote, !!conflict.blocked, conflict.reason || null])).digest('hex');
  function status(uid) {
    const doc = read(uid);
    if (!doc) return { connected: false, running: running.has(uid), conflicts: [] };
    const S = stateSafe(uid);
    const assignments = Object.entries(S?.dayPlan || {});
    const reviews = (S?.routines || []).filter(r => r.intervalsPlan?.needsReview && !r.ex?.length && assignments.some(([, id]) => id === r.id))
      .map(r => ({ id: r.id, date: assignments.find(([, id]) => id === r.id)[0], name: r.name }));
    return { connected: true, running: running.has(uid), athlete: doc.athlete, options: doc.options, lastSync: doc.lastSync || null, nextRun: doc.nextRun || null, error: doc.error || null, conflicts: Object.values(doc.conflicts || {}).map(c => ({ ...c, token: conflictToken(uid, doc, c) })), reviews, counts: doc.counts || {} };
  }
  const stateSafe = uid => { try { return readState(uid); } catch { return null; } };
  async function connect(uid, input, oauthAuth, isCurrent = () => true) {
    const opt = syncOptions(input);
    if (!oauthAuth && (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 8 || input.apiKey.length > 512)) throw new IntervalsError('Enter a valid Intervals.icu API key.', 400);
    const auth = oauthAuth || { apiKey: input.apiKey.trim() };
    const ticket = Symbol(); connecting.set(uid, ticket);
    let athlete;
    try { athlete = await createIntervalsClient(auth, { fetchImpl }).athlete(); }
    catch (e) { if (connecting.get(uid) === ticket) connecting.delete(uid); throw e; }
    const cancelled = connecting.get(uid) !== ticket || !userExists(uid) || !isCurrent();
    if (connecting.get(uid) === ticket) connecting.delete(uid);
    if (cancelled) throw new IntervalsError('Connection was cancelled. Start again from Settings.', 409);
    if (!athlete?.id) throw new IntervalsError('Intervals.icu did not identify the athlete.');
    const old = read(uid);
    if (running.has(uid)) throw new IntervalsError('Wait for the current sync to finish before reconnecting.', 409);
    const keep = old && String(old.athlete.id) === String(athlete.id);
    save(uid, { version: 1, generation: crypto.randomBytes(16).toString('hex'), auth: seal(auth), athlete: { id: String(athlete.id), name: String(athlete.name || '') }, options: opt, links: keep ? old.links : {}, conflicts: {}, nextRun: now() });
    return status(uid);
  }
  function configure(uid, input) {
    if (running.has(uid)) throw new IntervalsError('Wait for the current sync to finish.', 409);
    const doc = read(uid); if (!doc) throw new IntervalsError('Connect Intervals.icu first.', 409);
    doc.options = syncOptions({ ...doc.options, ...input }); save(uid, doc); return status(uid);
  }
  async function disconnect(uid) {
    connecting.delete(uid);
    const doc = read(uid);
    clearTimeout(timers.get(uid)); timers.delete(uid);
    try { fs.unlinkSync(filename(uid)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Removing the generation first invalidates every continuation of an in-flight poll.
    if (doc) try { await clientFor(doc).revoke(); } catch { /* local disconnect still succeeds after revocation/offline */ }
    return { connected: false, conflicts: [] };
  }
  async function perform(uid) {
    const doc = read(uid); if (!doc) return;
    if (doc.retryAt > now()) return;
    const client = clientFor(doc), opt = options(doc), range = rangeFor(opt);
    try {
      const fetched = {};
      // Sequential requests keep a large first sync from spending the athlete's API burst budget.
      for (const kind of ['activity', 'weight', 'plan']) {
        fetched[kind] = await client.list(kind, { oldest: kind === 'plan' ? range.today : range.oldest, newest: kind === 'plan' ? range.newest : range.today });
        if (!current(uid, doc)) return;
      }
      const records = localRecords(state(uid), opt);
      const localList = records.map(r => ({ ...r, key: planKey(r, doc, records) })), jobs = new Map();
      const add = (kind, id) => { const jobId = `${kind}:${id}`; if (!jobs.has(jobId)) jobs.set(jobId, { kind, key: id, baseline: doc.links[jobId] }); return jobs.get(jobId); };
      for (const r of localList) add(r.kind, r.key);
      for (const [id, link] of Object.entries(doc.links)) {
        const date = link.local?.date || link.remote?.date;
        if (date >= (link.kind === 'plan' ? range.today : range.oldest) && date <= (link.kind === 'plan' ? range.newest : range.today)) add(link.kind, link.key);
      }
      const blockedDates = new Set();
      const planDates = new Map();
      for (const r of fetched.plan) if (remoteRecord('plan', r)) { const d = r.start_date_local.slice(0, 10); planDates.set(d, (planDates.get(d) || 0) + 1); }
      for (const [date, n] of planDates) if (n > 1) blockedDates.add(date);
      for (const kind of ['activity', 'weight', 'plan']) for (const r of fetched[kind]) {
        const v = remoteRecord(kind, r); if (!v) continue;
        const linked = Object.values(doc.links).find(l => l.kind === kind && String(l.remoteId) === String(r.id));
        let id = linked?.key;
        if (!id) id = localList.find(l => l.kind === kind && r.external_id === externalId(uid, kind, l.key))?.key;
        if (!id && kind === 'weight') id = r.id;
        if (!id && kind === 'plan') id = localList.find(l => l.kind === kind && l.value.date === v.date)?.key;
        if (!id && kind === 'activity') {
          const matches = localList.filter(l => l.kind === kind && l.value.date === v.date && l.value.time === v.time && l.value.name === v.name);
          if (matches.length === 1) id = matches[0].key;
        }
        id ||= `intervals-${kind}-${r.id}`;
        add(kind, id).remote = r;
      }
      const conflicts = {}, counts = { pushed: 0, pulled: 0, unchanged: 0 };
      let operations = 0;
      for (const [jobId, job] of jobs) {
        if (!current(uid, doc)) return;
        const { kind, key: id, baseline } = job;
        let raw = job.remote;
        if (!raw && baseline?.remoteId != null) raw = await client.get(kind, baseline.remoteId);
        if (!current(uid, doc)) return;
        const remote = remoteRecord(kind, raw);
        let here = local(uid, kind, id, doc, baseline?.local);
        const target = kind === 'plan' && remote ? localRecords(state(uid), { ...opt, today: remote.date, futureDays: 1 }) : [];
        const occupied = target.some(r => r.kind === 'plan' && planKey(r, doc, target) !== id);
        const blocked = kind === 'plan' && (blockedDates.has(remote?.date || here?.date) || occupied);
        let action = blocked ? 'conflict' : decision(here, remote, baseline);
        const previous = doc.conflicts?.[jobId];
        if (!blocked && previous?.choice && equal(previous.local, here) && equal(previous.remote, remote)) action = previous.choice === 'local' ? 'push' : 'pull';
        if (action === 'conflict') {
          conflicts[jobId] = { id: jobId, kind, key: id, local: here, remote, blocked, ...(blocked ? { reason: occupied ? 'occupied-date' : 'multiple-events' } : {}) };
          continue;
        }
        if (action === 'push') {
          if (operations++ >= 100) { doc.nextRun = now() + 60000; break; }
          if (!here) { if (raw?.id != null) await client.remove(kind, raw.id); }
          else raw = await client.put(kind, here, { id: raw?.id, externalId: externalId(uid, kind, id) });
          if (!current(uid, doc)) return;
          const saved = here ? remoteRecord(kind, raw) : null;
          // The network request may have raced an edit in OpenGym. Remember exactly what was sent;
          // the new local change remains different from the baseline and will be pushed next time.
          doc.links[jobId] = { kind, key: id, remoteId: raw?.id ?? baseline?.remoteId ?? (kind === 'weight' ? id : null), local: here, remote: saved };
          counts.pushed++;
        } else if (action === 'pull') {
          const S = state(uid);
          if (!equal(local(uid, kind, id, doc, baseline?.local), here)) continue;
          // The read/compare/write below is synchronous; the server write adds its revision/stamps.
          applyRecord(S, kind, id, remote, now(), { ...opt, today: here?.date || remote?.date || opt.today, linkedDate: here?.date, futureDays: opt.futureDays });
          writeState(uid, S);
          here = local(uid, kind, id, doc, remote);
          doc.links[jobId] = { kind, key: id, remoteId: raw?.id ?? baseline?.remoteId, local: here, remote };
          counts.pulled++;
        } else {
          if (here || remote) doc.links[jobId] = { kind, key: id, remoteId: raw?.id ?? baseline?.remoteId ?? id, local: here, remote };
          counts.unchanged++;
        }
        delete doc.conflicts[jobId];
        save(uid, doc); // A later failed operation must not lose successful record links.
      }
      if (!current(uid, doc)) return;
      doc.conflicts = conflicts; doc.counts = counts; doc.lastSync = now(); doc.error = null; doc.failures = 0; doc.retryAt = 0;
      doc.nextRun = operations > 100 ? now() + 60000 : now() + POLL_MS;
      save(uid, doc);
    } catch (e) {
      if (!current(uid, doc)) return;
      doc.failures = (doc.failures || 0) + 1;
      doc.error = e instanceof IntervalsError ? e.message : 'Sync could not finish. Your data is kept; it will retry.';
      doc.retryAt = now() + Math.max((e.retryAfter || 0) * 1000, Math.min(3600000, 60000 * 2 ** Math.min(doc.failures - 1, 6)));
      if (e.status === 401 || e.status === 403) doc.retryAt = now() + 3600000;
      doc.nextRun = doc.retryAt; save(uid, doc);
    }
  }
  function run(uid) {
    if (running.has(uid)) return running.get(uid);
    const p = perform(uid).finally(() => running.delete(uid));
    running.set(uid, p); return p;
  }
  async function resolve(uid, id, choice, token) {
    if (running.has(uid)) throw new IntervalsError('Wait for the current sync to finish.', 409);
    const doc = read(uid), conflict = doc?.conflicts?.[id];
    if (!conflict || typeof token !== 'string' || token !== conflictToken(uid, doc, conflict)) throw new IntervalsError('Review the current conflict before choosing a side.', 409);
    if (!['local', 'remote'].includes(choice) || conflict.blocked) throw new IntervalsError('Choose an available conflict and side.', 400);
    conflict.choice = choice; save(uid, doc); await run(uid); return status(uid);
  }
  function schedule(uid) {
    if (timers.has(uid)) return;
    const timer = setTimeout(() => {
      timers.delete(uid);
      try { const doc = read(uid); if (doc?.options.enabled) run(uid).catch(() => {}); } catch { /* status reports unreadable integration */ }
    }, 5000);
    timer.unref(); timers.set(uid, timer);
  }
  async function tick() {
    for (const file of fs.readdirSync(dataDir)) {
      const m = /^intervals-([a-zA-Z0-9_-]+)\.json$/.exec(file); if (!m) continue;
      try {
        const uid = m[1], doc = read(uid);
        if (!userExists(uid)) { await disconnect(uid); continue; }
        if (doc.options.enabled && (doc.nextRun || 0) <= now()) await run(uid);
      } catch { /* one damaged profile must not stop the other polls */ }
    }
  }
  return { status, connect, configure, disconnect, run, resolve, schedule, tick, stop() { for (const t of timers.values()) clearTimeout(t); timers.clear(); } };
}
