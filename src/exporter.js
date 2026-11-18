// Converts Last.fm pages into export rows while preserving repeated plays.
const root = { scrobbles: 'recenttracks', artists: 'topartists', loved: 'lovedtracks' };
const fold = (name) => name.normalize('NFC').toLowerCase();

export const columns = {
  scrobbles: ['played_at', 'artist', 'track', 'album', 'lastfm_url'],
  artists: ['rank', 'artist', 'scrobbles'],
  albums: ['rank', 'artist', 'album', 'scrobbles'],
  tracks: ['rank', 'artist', 'track', 'scrobbles'],
  loved: ['loved_at', 'artist', 'track', 'lastfm_url'],
};

// Match pasted names to the spelling saved in the artist index.
export function matchArtists(input, names) {
  const byName = new Map(names.map((name) => [fold(name), name]));
  const matches = new Set();
  const unmatched = new Map();
  for (const rawLine of input.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line === "'''" || line === '```') continue;
    // A whole line may itself be an artist name containing a comma.
    const entries = byName.has(fold(line)) ? [line] : line.split(',');
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      const key = fold(entry);
      if (byName.has(key)) matches.add(byName.get(key));
      else if (!unmatched.has(key)) unmatched.set(key, entry);
    }
  }
  return { matches: [...matches], unmatched: [...unmatched.values()] };
}

export function dates(period, start, end, now = new Date()) {
  const nextSecond = Math.floor(now.getTime() / 1000) + 1;
  if (period === 'all') return { to: nextSecond };
  let from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let to = nextSecond;
  if (period === 'custom') {
    if (!start || !end || start > end) throw Error('Enter a start and end date in order.');
    from = new Date(start + 'T00:00:00');
    const after = new Date(end + 'T00:00:00');
    after.setDate(after.getDate() + 1);
    to = Math.min(to, Math.floor(after.getTime() / 1000));
  } else {
    from.setDate(from.getDate() - Number(period) + 1);
  }
  const firstSecond = Math.floor(from.getTime() / 1000);
  if (!Number.isFinite(firstSecond) || !Number.isFinite(to) || firstSecond >= to || firstSecond < 0) {
    throw Error('Choose a valid date range that starts today or earlier.');
  }
  // Last.fm's lower bound is exclusive.
  return { from: Math.max(0, firstSecond - 1), to };
}

export async function requestLibrary(url, signal, method = 'GET') {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    let response;
    let data;
    try {
      response = await fetch(url, { signal, method });
      data = await response.json();
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 4) throw Error('The connection was interrupted.', { cause: error });
    }
    if (response?.ok && data) return data;
    const retryable = !data || [429, 502, 503, 504].includes(response.status) && !data.message?.includes('configured');
    if (!retryable || attempt === 4) throw Error(data?.message || 'The library request failed.');
    const retryAfter = response?.headers.get('Retry-After');
    const requestedDelay = Number(retryAfter) || (Date.parse(retryAfter) - Date.now()) / 1000 || 0;
    await delay(1000 * Math.max(2 ** attempt, requestedDelay), signal);
  }
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function readLibrary(kind, range, signal, onPage) {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    try {
      const query = new URLSearchParams({ kind, page, ...range });
      const response = await requestLibrary('/api/library?' + query, signal);
      const collection = response[root[kind]];
      const items = collection?.[kind === 'artists' ? 'artist' : 'track'];
      const pages = Number(collection?.['@attr']?.totalPages ?? (Number(collection?.['@attr']?.total) === 0 ? 0 : NaN));
      if (!Array.isArray(items) || !Number.isSafeInteger(pages) || pages < 0 ||
          (!items.length && (page > 1 || pages > 1))) {
        throw Error('Last.fm returned incomplete pagination data.');
      }
      // Scrobble requests use a fixed upper bound, so the expected page count is stable.
      if (page === 1) totalPages = pages;
      if (page > 1 && page > pages) throw Error('Last.fm’s page count changed. Try again.');
      onPage(items, page, totalPages);
      if (page < totalPages) await delay(125, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw Error('Page ' + page + ': ' + error.message, { cause: error });
    }
  }
}

export function collect(kind, range, selection) {
  const rows = [];
  const grouped = new Map();
  const allowed = new Set(selection.map(fold));
  const groupedKind = ['artists', 'albums', 'tracks'].includes(kind);

  return {
    add(items) {
      for (const item of items) {
        if (item['@attr']?.nowplaying === 'true') continue;
        const stamp = Number(item.date?.uts);
        if (!Number.isFinite(stamp) || stamp <= 0) throw Error('A library entry is missing its timestamp.');
        if (stamp <= range.from || stamp >= range.to) continue;
        const artist = item.artist?.name ?? item.artist?.['#text'] ?? '';
        if (allowed.size && !allowed.has(fold(artist))) continue;
        const track = item.name ?? '';
        const album = item.album?.['#text'] ?? '';
        if (groupedKind) {
          if (kind === 'albums' && !album) continue;
          const fields = kind === 'artists' ? { artist } : kind === 'albums' ? { artist, album } : { artist, track };
          const key = JSON.stringify(Object.values(fields).map(fold));
          if (!grouped.has(key)) grouped.set(key, { ...fields, scrobbles: 0 });
          grouped.get(key).scrobbles += 1;
        } else {
          const iso = new Date(stamp * 1000).toISOString();
          const lastfm_url = item.url ?? '';
          rows.push(kind === 'loved' ? { loved_at: iso, artist, track, lastfm_url } :
            { played_at: iso, artist, track, album, lastfm_url });
        }
      }
    },
    result() {
      if (!groupedKind) return rows;
      return [...grouped.values()]
        .sort((a, b) => b.scrobbles - a.scrobbles ||
          a.artist.localeCompare(b.artist) ||
          (a.album ?? a.track ?? '').localeCompare(b.album ?? b.track ?? ''))
        .map((row, i) => ({ rank: i + 1, ...row }));
    },
  };
}

export function fileFor(kind, format, rows) {
  if (format === 'json') return new Blob([JSON.stringify(rows)], { type: 'application/json' });
  const fields = columns[kind];
  const escape = (value) => {
    if (typeof value === 'number') return value;
    // Protect spreadsheet users from formula-like names coming from Last.fm.
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return new Blob(['\uFEFF', fields.join(',') + '\r\n',
    ...rows.map((row) => fields.map((field) => escape(row[field])).join(',') + '\r\n')],
  { type: 'text/csv;charset=utf-8' });
}
