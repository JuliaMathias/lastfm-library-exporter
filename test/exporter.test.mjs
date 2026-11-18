import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, dates, fileFor, matchArtists, readLibrary } from '../src/exporter.js';
import worker from '../dist/server/index.js';

const play = (artist, name, album, time = 100) => ({
  artist: { '#text': artist }, name, album: { '#text': album }, date: { uts: String(time) },
});

test('custom boundaries include the first and last seconds of the selected day', () => {
  const now = new Date('2026-11-18T13:00:00');
  const range = dates('custom', '2026-11-17', '2026-11-17', now);
  const rows = collect('scrobbles', range, []);
  rows.add([
    play('A', 'before', 'a', range.from),
    play('A', 'first', 'a', range.from + 1),
    play('A', 'last', 'a', range.to - 1),
    play('A', 'after', 'a', range.to),
  ]);
  assert.deepEqual(rows.result().map(row => row.track), ['first', 'last']);
  assert.throws(() => dates('custom', '2026-11-18', '2026-11-17', now));
});

test('groups matching plays by artist and title while preserving repeated scrobbles', () => {
  const inputs = [play('EXM', 'DRIFT', 'Still Water'), play('exm', 'Drift', 'Still Water'),
    play('EXM', 'Other', ''), play('Other artist', 'DRIFT', 'Still Water'),
    { '@attr': { nowplaying: 'true' } }];
  const tracks = collect('tracks', { to: 101 }, ['EXM']);
  tracks.add(inputs);
  assert.deepEqual(tracks.result(), [
    { rank: 1, artist: 'EXM', track: 'DRIFT', scrobbles: 2 },
    { rank: 2, artist: 'EXM', track: 'Other', scrobbles: 1 },
  ]);
  const albums = collect('albums', { to: 101 }, ['EXM']);
  albums.add(inputs);
  assert.equal(albums.result().length, 1);
  const scrobbles = collect('scrobbles', { to: 101 }, ['EXM']);
  scrobbles.add(inputs);
  assert.equal(scrobbles.result().length, 3);
});

test('loved timestamps survive export and original names remain in JSON', async () => {
  const loved = collect('loved', { from: 90, to: 101 }, ['Singer']);
  loved.add([{ artist: { name: 'Singer' }, name: '=Hello, "world"', date: { uts: '100' } }]);
  const rows = loved.result();
  assert.equal(rows[0].loved_at, '1970-01-01T00:01:40.000Z');
  assert.equal(JSON.parse(await fileFor('loved', 'json', rows).text())[0].track, '=Hello, "world"');
  assert.match(await fileFor('loved', 'csv', rows).text(), /"'=Hello, ""world"""/);
});

test('pagination loads every page and rejects incomplete results', async (t) => {
  const requests = [];
  const mock = t.mock.method(globalThis, 'fetch', async (input) => {
    const page = Number(new URL(input, 'https://example.test').searchParams.get('page'));
    requests.push(page);
    return Response.json({ recenttracks: { '@attr': { totalPages: 2 }, track: [play('A', 'T', 'A')] } });
  });
  const results = [];
  await readLibrary('scrobbles', { to: 101 }, new AbortController().signal,
    (items) => results.push(...items));
  assert.deepEqual(requests, [1, 2]);
  assert.equal(results.length, 2);
  mock.mock.mockImplementation(async () => Response.json({ recenttracks: { track: [] } }));
  await assert.rejects(readLibrary('scrobbles', {}, new AbortController().signal, () => {}),
    /incomplete pagination/);
});

test('worker authenticates API callers and only forwards ExampleListener read requests', async (t) => {
  const base = 'https://example.test/api/library?kind=scrobbles&user=SomeoneElse&from=90&to=101';
  const env = { LASTFM_USERNAME: 'ExampleListener', LASTFM_API_KEY: 'synthetic-test-key' };
  const mock = t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(typeof input, 'string');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    const url = new URL(input);
    assert.equal(url.hostname, 'ws.audioscrobbler.com');
    assert.equal(url.searchParams.get('user'), 'ExampleListener');
    assert.equal(url.searchParams.get('method'), 'user.getRecentTracks');
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(url.searchParams.get('to'), '101');
    return Response.json({ recenttracks: {} });
  });
  assert.equal((await worker.fetch(new Request(base), env)).status, 401);
  const headers = { 'oai-authenticated-user-id': 'test-user' };
  assert.equal((await worker.fetch(new Request(base.replace('scrobbles', 'write'), { headers }), env)).status, 400);
  assert.equal((await worker.fetch(new Request(base, { headers }), { LASTFM_USERNAME: 'ExampleListener' })).status, 503);
  const response = await worker.fetch(new Request(base, { headers }), env);
  assert.deepEqual(await response.json(), { recenttracks: {} });
  assert.equal(mock.mock.callCount(), 1);
});

test('the all-time artists call uses a string URL and returns Last.fm pagination', async (t) => {
  const payload = { topartists: { artist: [{ name: 'EXM' }], '@attr': { totalPages: '2' } } };
  t.mock.method(AbortSignal, 'timeout', () => { throw new Error('Unsupported timeout helper'); });
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(typeof input, 'string');
    const query = new URL(input).searchParams;
    assert.equal(query.get('method'), 'user.getTopArtists');
    assert.equal(query.get('period'), 'overall');
    assert.equal(query.get('page'), '1');
    return Response.json(payload);
  });
  const response = await worker.fetch(new Request('https://example.test/api/library?kind=artists', {
    headers: { 'oai-authenticated-user-id': 'test-user' },
  }), { LASTFM_USERNAME: 'ExampleListener', LASTFM_API_KEY: 'synthetic-test-key' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test('pasted artist lists match synced names in both formats', () => {
  const names = ['EXM', 'Paper Lanterns', 'MIDNIGHT SIGNAL', 'Twenty One Echoes',
    'Example Singer', 'August Day', 'Modern Notebook', 'NØrth', 'VX', 'The Fictionals'];
  for (const separator of ['\n', ', ']) {
    assert.deepEqual(matchArtists(names.join(separator), names), { matches: names, unmatched: [] });
  }
});

test('artist matching preserves canonical names, handles comma names on their own line, and reports misses', () => {
  const names = ['EXM', 'NØrth', 'Café Example', 'Storm, Glass & Stone'];
  const input = "'''\r\n exm, EXM , nØRTH\r\n Storm, Glass & Stone\r\n Cafe\u0301 Example, North, north, Unknown\r\n'''";
  assert.deepEqual(matchArtists(input, names), { matches: names.slice(0, 2).concat(names[3], names[2]),
    unmatched: ['North', 'Unknown'] });
});
