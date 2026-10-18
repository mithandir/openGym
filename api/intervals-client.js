import { payloadFor } from './intervals-model.js';

const BASE = 'https://intervals.icu';
const MAX_RESPONSE = 8 * 1024 * 1024;
export class IntervalsError extends Error {
  constructor(message, status = 502, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
// Never expose third-party error bodies: they can contain credentials or athlete data.
export async function intervalsRequest(path, { fetchImpl = globalThis.fetch, headers = {}, method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetchImpl(BASE + path, { method, headers, ...(body != null ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (e?.status) throw e;
    throw new IntervalsError('Intervals.icu could not be reached. Try again later.');
  }
  if (!r.ok) {
    const retry = r.headers.get('retry-after');
    const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000) || 0;
    await r.body?.cancel();
    throw new IntervalsError(r.status === 401 || r.status === 403 ? 'Intervals.icu access was refused. Reconnect and grant activity, wellness, and calendar write access.' : r.status === 429 ? 'Intervals.icu rate limit reached. Sync will retry later.' : `Intervals.icu request failed (${r.status}).`, r.status, seconds);
  }
  if (r.status === 204) return null;
  let bytes = 0, chunks = [];
  for await (const chunk of r.body || []) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE) throw new IntervalsError('Intervals.icu response is too large. Reduce the sync range.');
    chunks.push(chunk);
  }
  try { return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; }
  catch { throw new IntervalsError('Intervals.icu returned an invalid response.'); }
}
export function createIntervalsClient(auth, { fetchImpl = globalThis.fetch } = {}) {
  const headers = { Authorization: auth.accessToken ? `Bearer ${auth.accessToken}` : `Basic ${Buffer.from('API_KEY:' + auth.apiKey).toString('base64')}`, 'Content-Type': 'application/json' };
  const request = (path, method = 'GET', body) => intervalsRequest('/api/v1' + path, { fetchImpl, headers, method, body: body == null ? undefined : JSON.stringify(body) });
  const resource = (kind, id) => kind === 'activity' ? `/activity/${encodeURIComponent(id)}` : `/athlete/0/${kind === 'plan' ? 'events' : 'wellness'}/${encodeURIComponent(id)}`;
  return {
    athlete: () => request('/athlete/0'),
    async list(kind, { oldest, newest }) {
      const name = { activity: 'activities', plan: 'events', weight: 'wellness' }[kind];
      const result = await request(`/athlete/0/${name}?${new URLSearchParams({ oldest, newest })}`);
      if (!Array.isArray(result)) throw new IntervalsError('Intervals.icu returned an invalid list.');
      return result;
    },
    async get(kind, id) { try { return await request(resource(kind, id)); } catch (e) { if (e.status === 404) return null; throw e; } },
    async put(kind, v, { id, externalId } = {}) {
      const payload = payloadFor(kind, v, externalId);
      if (kind === 'weight') return request(resource(kind, v.date), 'PUT', { weight: v.weight });
      if (id != null) return request(resource(kind, id), 'PUT', payload);
      const results = await request(kind === 'plan' ? '/athlete/0/events/bulk?upsert=true' : '/athlete/0/activities/manual/bulk', 'POST', [payload]);
      if (!Array.isArray(results) || results.length !== 1 || results[0]?.id == null) throw new IntervalsError('Intervals.icu did not confirm the saved record.');
      return results[0];
    },
    // Numeric wellness fields clear with -1. JSON null is ignored by the live API.
    remove: (kind, id) => request(resource(kind, id), kind === 'weight' ? 'PUT' : 'DELETE', kind === 'weight' ? { weight: -1 } : undefined),
    revoke: () => auth.accessToken ? request('/disconnect-app', 'DELETE') : Promise.resolve(),
  };
}
