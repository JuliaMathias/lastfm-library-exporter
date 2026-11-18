// Persists artist names and advances the Last.fm cursor atomically, one page at a time.
async function artistIndex(env, method, json, loadPage) {
  const db = env.DB;
  if (!db) return json({ message: 'The artist database is unavailable.' }, 503);
  try {
    if (method === 'GET') {
      const [state, artists] = await db.batch([
        db.prepare('SELECT through_at FROM artist_sync WHERE id = 1'),
        db.prepare('SELECT name FROM artist_index ORDER BY name COLLATE NOCASE'),
      ]);
      const through = state.results[0].through_at;
      return json({
        names: through === null ? [] : artists.results.map((row) => row.name),
        synced: through === null ? null : new Date(through * 1000).toISOString(),
      });
    }

    const cutoff = Math.floor(Date.now() / 1000) - 1;
    const [, state] = await db.batch([
      db.prepare(`UPDATE artist_sync SET cutoff_at = ?, revision = revision + 1
        WHERE id = 1 AND cutoff_at IS NULL AND (through_at IS NULL OR through_at < ?)`).bind(cutoff, cutoff),
      db.prepare('SELECT through_at, cutoff_at, next_page, revision FROM artist_sync WHERE id = 1'),
    ]);
    const { through_at: through, cutoff_at: to, next_page: page, revision } = state.results[0];
    if (to === null) return json({ done: true });

    // Bootstrap via the all-time ranking. Later runs only scan timestamped, newer plays.
    const initial = through === null;
    const kind = initial ? 'artists' : 'scrobbles';
    const bounds = initial ? {} : { from: through, to: to + 1 };
    const response = await loadPage(env, kind, page, bounds, json);
    if (!response.ok) return response;
    const data = await response.json();
    const collection = initial ? data.topartists : data.recenttracks;
    const items = initial ? collection?.artist : collection?.track;
    const total = Number(collection?.['@attr']?.totalPages);
    if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0 ||
        (total < page && (page !== 1 || total !== 0)) ||
        (!items.length && total > 0)) {
      return json({ message: 'Last.fm returned incomplete artist sync data. Try syncing again.' }, 502);
    }

    const names = new Map();
    for (const item of items) {
      if (!initial) {
        if (item['@attr']?.nowplaying === 'true') continue;
        const timestamp = Number(item.date?.uts);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
          return json({ message: 'Last.fm returned a play without a timestamp.' }, 502);
        }
        if (timestamp <= through || timestamp > to) continue;
      }
      const name = initial ? item.name : item.artist?.['#text'];
      if (typeof name !== 'string' || !name.trim()) {
        return json({ message: 'Last.fm returned an entry without an artist name.' }, 502);
      }
      names.set(name.normalize('NFC').toLowerCase(), name);
    }

    const done = page >= total;
    const [, update] = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO artist_index (artist_key, name)
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM artist_sync WHERE id = 1 AND revision = ?)`)
        .bind(JSON.stringify([...names]), revision),
      db.prepare(`UPDATE artist_sync SET through_at = ?, cutoff_at = ?, next_page = ?, revision = revision + 1
        WHERE id = 1 AND revision = ?`)
        .bind(done ? to : through, done ? null : to, done ? 1 : page + 1, revision),
    ]);
    if (!update.meta.changes) return json({ changed: true });
    return json({ done, initial, page, total, cutoff: to });
  } catch {
    console.warn('Artist database operation failed', method);
    return json({ message: 'The artist database could not finish the request. Try syncing again.' }, 503);
  }
}
