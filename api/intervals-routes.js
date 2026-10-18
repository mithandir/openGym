import crypto from 'node:crypto';
import { IntervalsError, intervalsRequest } from './intervals-client.js';
import { syncOptions } from './intervals-sync.js';

const SCOPES = ['ACTIVITY:WRITE', 'WELLNESS:WRITE', 'CALENDAR:WRITE'];
export function intervalsRoutes({ sync, json, readBody, readSession, origin, oauth = {}, fetchImpl, now = Date.now }) {
  // Pending states expire; active tickets live only until their request settles.
  const pending = new Map(), active = new Set();
  function cancel(uid) {
    for (const [key, entry] of pending) if (entry.uid === uid) pending.delete(key);
    for (const entry of active) if (entry.uid === uid) entry.cancelled = true;
  }
  const check = entry => { if (entry.cancelled) throw new IntervalsError('Connection was cancelled. Start again from Settings.', 409); };
  const available = !!(oauth.clientId && oauth.clientSecret);
  const redirectUri = oauth.redirectUri || origin.replace(/\/$/, '') + '/api/intervals/oauth/callback';
  const wrap = fn => async (req, res) => {
    const user = readSession(req); if (!user) return json(res, 401, { error: 'not signed in' });
    try { return await fn(req, res, user); }
    catch (e) { if (e instanceof IntervalsError) return json(res, e.status >= 500 ? 502 : e.status, { error: e.message }); throw e; }
  };
  return {
    'GET /api/intervals/status': wrap(async (req, res, user) => json(res, 200, { ...sync.status(user.id), oauthAvailable: available })),
    'POST /api/intervals/connect': wrap(async (req, res, user) => {
      cancel(user.id);
      const entry = { uid: user.id }; active.add(entry);
      try {
        const body = await readBody(req); check(entry);
        json(res, 200, await sync.connect(user.id, body, undefined, () => !entry.cancelled));
      } finally { active.delete(entry); }
    }),
    'PUT /api/intervals/settings': wrap(async (req, res, user) => json(res, 200, sync.configure(user.id, await readBody(req)))),
    'POST /api/intervals/sync': wrap(async (req, res, user) => {
      if (!sync.status(user.id).connected) throw new IntervalsError('Connect Intervals.icu first.', 409);
      sync.run(user.id).catch(() => {});
      json(res, 202, sync.status(user.id));
    }),
    'POST /api/intervals/resync-activities': wrap(async (req, res, user) => {
      sync.resyncActivities(user.id);
      sync.run(user.id).catch(() => {});
      json(res, 202, sync.status(user.id));
    }),
    'POST /api/intervals/resolve': wrap(async (req, res, user) => {
      const body = await readBody(req);
      json(res, 200, await sync.resolve(user.id, body.id, body.choice, body.token));
    }),
    'DELETE /api/intervals/connect': wrap(async (req, res, user) => {
      cancel(user.id);
      json(res, 200, await sync.disconnect(user.id));
    }),
    'POST /api/intervals/oauth/start': wrap(async (req, res, user) => {
      if (!available) throw new IntervalsError('OAuth is not configured by this server. Use a personal API key or ask the server owner to configure OAuth.', 409);
      cancel(user.id);
      const entry = { uid: user.id }; active.add(entry);
      try {
        const options = syncOptions(await readBody(req)); check(entry);
        for (const [key, pendingEntry] of pending) if (pendingEntry.expires < now()) pending.delete(key);
        if (pending.size >= 500) throw new IntervalsError('Too many pending connections. Try again shortly.', 429);
        const state = crypto.randomBytes(32).toString('base64url');
        pending.set(state, { uid: user.id, expires: now() + 10 * 60000, options });
        const url = 'https://intervals.icu/oauth/authorize?' + new URLSearchParams({ client_id: oauth.clientId, redirect_uri: redirectUri, scope: SCOPES.join(','), state });
        json(res, 200, { url });
      } finally { active.delete(entry); }
    }),
    'GET /api/intervals/oauth/callback': async (req, res) => {
      const url = new URL(req.url, origin), token = url.searchParams.get('state');
      const entry = pending.get(token); pending.delete(token);
      const user = readSession(req);
      if (!entry || entry.expires < now() || user?.id !== entry.uid || !url.searchParams.get('code') || url.searchParams.has('error')) return json(res, 400, { error: 'Intervals.icu connection expired or was refused. Start again from OpenGym Settings.' });
      active.add(entry);
      try {
        const grant = await intervalsRequest('/api/oauth/token', { fetchImpl, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code: url.searchParams.get('code') }).toString() });
        check(entry);
        const scopes = String(grant?.scope || '').split(/[ ,]+/);
        if (!grant?.access_token || !SCOPES.every(s => scopes.includes(s))) throw new IntervalsError('Grant activity, wellness, and calendar write access to enable two-way sync.', 400);
        await sync.connect(user.id, entry.options, { accessToken: grant.access_token }, () => !entry.cancelled);
        // Relative to the registered callback, so installations below a URL prefix return there.
        const target = new URL(redirectUri); target.pathname = target.pathname.replace(/api\/intervals\/oauth\/callback$/, ''); target.search = ''; target.hash = '/settings/data';
        res.writeHead(303, { Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
      } catch (e) { json(res, e instanceof IntervalsError && e.status < 500 ? e.status : 502, { error: e instanceof IntervalsError ? e.message : 'Intervals.icu connection failed. Start again from Settings.' }); }
      finally { active.delete(entry); }
    },
  };
}
