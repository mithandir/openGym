// Loaded only into the test child; production has no configurable API base URL.
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://intervals.icu/')) return original(url, options);
  const path = new URL(url).pathname;
  if (path === '/api/v1/athlete/0') return Response.json({ id: 'i-test', name: 'Test athlete' });
  if (path.endsWith('/wellness')) return Response.json([{ id: new Date().toISOString().slice(0, 10), weight: 81 }]);
  if (path.endsWith('/activities') || path.endsWith('/events')) return Response.json([]);
  throw new Error('Unexpected fake Intervals request: ' + path);
};
