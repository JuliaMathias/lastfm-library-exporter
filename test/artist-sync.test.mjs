import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../dist/server/index.js';
import { sqliteBinding } from '../sqlite.mjs';

function dbForTest(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../drizzle/0000_artist_index.sql', import.meta.url), 'utf8'));
  return sqliteBinding(sqlite);
}

test('artist sync resumes a failed import and later fetches only new plays', async (t) => {
  const origin = 'https://exporter.example';
  const env = { DB: dbForTest(t), LASTFM_USERNAME: 'ExampleListener', LASTFM_API_KEY: 'synthetic' };
  const request = (method, headers = { Origin: origin, 'oai-authenticated-user-id': 'test' }) =>
    worker.fetch(new Request(origin + '/api/artists', { method, headers }), env);
  assert.equal((await request('GET', {})).status, 401);
  assert.equal((await request('POST', { Origin: 'https://elsewhere.example', 'oai-authenticated-user-id': 'test' })).status, 403);

  const firstCutoff = 1795020000;
  t.mock.timers.enable({ apis: ['Date'], now: (firstCutoff + 1) * 1000 });
  let allowSecondPage = false;
  let emptyWindow = false;
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const params = new URL(url).searchParams;
    const page = Number(params.get('page'));
    const method = params.get('method');
    seen.push([method, page]);
    if (method === 'user.getTopArtists') {
      if (page === 2 && !allowSecondPage) return Response.json({ error: 16 });
      const name = page === 1 ? 'EXM' : 'Older artist';
      return Response.json({ topartists: { artist: [{ name }], '@attr': { totalPages: '2' } } });
    }
    assert.equal(method, 'user.getRecentTracks');
    if (emptyWindow) {
      assert.equal(params.get('from'), String(firstCutoff + 60));
      return Response.json({ recenttracks: {
        track: { '@attr': { nowplaying: 'true' } },
        '@attr': { totalPages: '0', total: '0' },
      } });
    }
    assert.equal(params.get('from'), String(firstCutoff));
    assert.equal(params.get('to'), String(firstCutoff + 61));
    const play = (name, time) => ({ artist: { '#text': name }, date: { uts: time } });
    return Response.json({ recenttracks: { track: [
      play('old outside window', firstCutoff),
      play('exm', firstCutoff + 1),
      play('New Artist', firstCutoff + 60),
      { '@attr': { nowplaying: 'true' } },
    ], '@attr': { totalPages: '1' } } });
  });

  assert.equal((await (await request('POST')).json()).done, false);
  assert.equal((await request('POST')).status, 502);
  assert.deepEqual(await (await request('GET')).json(), { names: [], synced: null });
  allowSecondPage = true;
  assert.equal((await (await request('POST')).json()).done, true);
  assert.deepEqual((await (await request('GET')).json()).names, ['EXM', 'Older artist']);

  t.mock.timers.setTime((firstCutoff + 61) * 1000);
  assert.equal((await (await request('POST')).json()).done, true);
  const result = await (await request('GET')).json();
  assert.equal(result.synced, new Date((firstCutoff + 60) * 1000).toISOString());
  assert.deepEqual(result.names, ['EXM', 'New Artist', 'Older artist']);
  emptyWindow = true;
  t.mock.timers.setTime((firstCutoff + 121) * 1000);
  assert.equal((await (await request('POST')).json()).done, true);
  const afterEmpty = await (await request('GET')).json();
  assert.equal(afterEmpty.synced, new Date((firstCutoff + 120) * 1000).toISOString());
  assert.deepEqual(afterEmpty.names, result.names);
  assert.deepEqual(seen, [
    ['user.getTopArtists', 1], ['user.getTopArtists', 2], ['user.getTopArtists', 2],
    ['user.getRecentTracks', 1], ['user.getRecentTracks', 1],
  ]);
});
