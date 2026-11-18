// Serves the owner-only UI and forwards allowlisted, read-only requests for the configured account.
const methods = {
  scrobbles: 'user.getRecentTracks',
  artists: 'user.getTopArtists',
  loved: 'user.getLovedTracks',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const json = (value, status = 200, extra = {}) =>
      Response.json(value, { status, headers: { ...headers, ...extra } });

    if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      const [body, type] = assets[url.pathname];
      return new Response(body, { headers: {
        ...headers, 'Content-Type': type + '; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'",
      } });
    }

    if (!request.headers.get('oai-authenticated-user-id')) {
      return json({ message: 'Sign in to access your library.' }, 401);
    }
    if (url.pathname === '/api/artists') {
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) {
        return json({ message: 'Start artist sync from this site.' }, 403);
      }
      if (!['GET', 'POST'].includes(request.method)) return json({ message: 'Method unavailable.' }, 405);
      return artistIndex(env, request.method, json, lastfmPage);
    }
    if (url.pathname !== '/api/library') return json({ message: 'Page unavailable.' }, 404);
    if (request.method !== 'GET') return json({ message: 'Method unavailable.' }, 405);

    const kind = url.searchParams.get('kind');
    const page = url.searchParams.get('page') ?? '1';
    if (!Object.hasOwn(methods, kind) || !/^[1-9]\d*$/.test(page)) {
      return json({ message: 'Invalid library request.' }, 400);
    }

    return lastfmPage(env, kind, page, Object.fromEntries(url.searchParams), json);
  },
};

async function lastfmPage(env, kind, page, bounds, json) {
  if (!env.LASTFM_API_KEY || !env.LASTFM_USERNAME) {
    return json({ message: 'Set LASTFM_USERNAME and LASTFM_API_KEY on the server.' }, 503);
  }
  const upstream = new URL('https://ws.audioscrobbler.com/2.0/');
  upstream.search = new URLSearchParams({
    method: methods[kind], user: env.LASTFM_USERNAME, api_key: env.LASTFM_API_KEY,
    format: 'json', page, limit: kind === 'scrobbles' ? '200' : '50',
  });
  if (kind === 'artists') upstream.searchParams.set('period', 'overall');
  if (kind === 'scrobbles') {
    for (const name of ['from', 'to']) {
      const timestamp = bounds[name];
      if (timestamp == null) continue;
      if (!/^\d{1,12}$/.test(timestamp)) return json({ message: 'Invalid date.' }, 400);
      upstream.searchParams.set(name, timestamp);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let stage = 'connection';
  try {
    const response = await fetch(upstream.href, { redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      console.warn('Last.fm returned an unexpected redirect', kind, response.status);
      return json({ message: 'Last.fm redirected the API request.' }, 502);
    }
    if (response.status === 429) return json({ message: 'Last.fm is rate limiting requests.' }, 429,
      { 'Retry-After': response.headers.get('Retry-After') ?? '3' });
    if (response.status >= 500) {
      console.warn('Last.fm returned an upstream error', kind, response.status);
      return json({ message: 'Last.fm is temporarily unavailable.' }, 502);
    }
    stage = 'response';
    const data = await response.json();
    if (data.error === 29) return json({ message: 'Last.fm is rate limiting requests.' }, 429);
    if ([10, 26].includes(data.error)) return json({ message: 'Last.fm rejected the configured API key.' }, 403);
    if ([11, 16].includes(data.error)) {
      return json({ message: 'Last.fm is temporarily unavailable.' }, 502);
    }
    if (data.error || !response.ok) return json({ message: 'Last.fm could not return this library page.' }, 422);
    const recent = data.recenttracks;
    // A zero-play window can contain a single now-playing object instead of an array.
    if (kind === 'scrobbles' && Number(recent?.['@attr']?.total) === 0 &&
        recent.track?.['@attr']?.nowplaying === 'true') {
      recent.track = [];
    }
    return json(data);
  } catch (error) {
    // This request URL contains an API key. Log only fixed diagnostic categories.
    const failure = controller.signal.aborted ? 'timeout'
      : error instanceof SyntaxError ? 'invalid JSON'
      : error instanceof TypeError ? 'request error'
      : 'unexpected error';
    console.warn('Last.fm API request failed', kind, stage, failure);
    return json({ message: controller.signal.aborted
      ? 'Last.fm took too long to respond.'
      : 'Last.fm did not return a usable response.' }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
