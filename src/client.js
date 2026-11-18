import { collect, columns, dates, delay, fileFor, matchArtists, readLibrary, requestLibrary } from './exporter.js';

const el = (id) => document.getElementById(id);
const form = el('export-form');
const range = el('range');
const search = el('search');
const choices = el('choices');
const artistList = el('artist-list');
const matchButton = el('match-artists');
const matchStatus = el('match-status');
const clearArtists = el('clear-artists');
const artistFilterStatus = el('artist-filter-status');
const status = el('status');
const preview = el('preview');
const sync = el('sync');
const cancel = el('cancel');
const selected = new Set();
const numbers = new Intl.NumberFormat();
let artistCache;
let operation;
let previousExport;

requestLibrary('/api/artists', new AbortController().signal).then((data) => {
  if (data.synced && !artistCache) {
    artistCache = data;
    renderArtistStatus();
  }
}).catch((error) => {
  if (!operation && !artistCache) el('artist-status').textContent = error.message;
});

function currentKind() {
  return new FormData(form).get('kind');
}

function renderArtistStatus() {
  const canSelect = !!artistCache?.synced && !operation;
  search.disabled = !canSelect;
  artistList.disabled = !canSelect;
  matchButton.disabled = !canSelect || !artistList.value.trim();
  el('artist-status').textContent = artistCache
    ? numbers.format(artistCache.names.length) + ' artists · synced ' + new Date(artistCache.synced).toLocaleString()
    : 'The first sync imports your all-time artists. Later syncs check new plays.';
}

function invalidate() {
  previousExport = undefined;
  preview.hidden = true;
  status.textContent = '';
}

function refreshControls() {
  for (const control of form.elements) {
    if (control instanceof HTMLFieldSetElement || control === cancel) continue;
    control.disabled = !!operation;
  }
  cancel.hidden = !operation;
  renderArtistStatus();
  if (operation) choices.hidden = true;
}

function renderSearch() {
  const query = search.value.trim().toLowerCase();
  choices.replaceChildren();
  if (!query || !artistCache) {
    choices.hidden = true;
    return;
  }
  const matches = artistCache.names.filter((name) => name.toLowerCase().includes(query) && !selected.has(name));
  for (const name of matches.slice(0, 40)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => {
      selected.add(name);
      search.value = '';
      renderSearch();
      renderSelection();
      invalidate();
      search.focus();
    });
    choices.append(button);
  }
  if (!matches.length || matches.length > 40) {
    const hint = document.createElement('p');
    hint.textContent = matches.length ? 'Keep typing to narrow the results.' : 'No matching artists.';
    choices.append(hint);
  }
  choices.hidden = false;
}

function renderSelection() {
  const count = selected.size;
  clearArtists.hidden = !count;
  artistFilterStatus.textContent = count
    ? 'Export includes only ' + numbers.format(count) + ' selected ' + (count === 1 ? 'artist.' : 'artists.')
    : 'Export includes all artists. Select artists to narrow it down.';
  el('selected').replaceChildren(...[...selected].map((name) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name + ' ×';
    button.setAttribute('aria-label', 'Remove ' + name);
    button.addEventListener('click', () => {
      selected.delete(name);
      renderSelection();
      renderSearch();
      invalidate();
      search.focus();
    });
    return button;
  }));
}

async function run(task) {
  if (operation) return;
  operation = new AbortController();
  refreshControls();
  try {
    await task(operation.signal);
  } catch (error) {
    status.textContent = operation.signal.aborted ? 'Cancelled.' : error.message;
  } finally {
    operation = undefined;
    refreshControls();
  }
}

search.addEventListener('input', renderSearch);
artistList.addEventListener('input', () => {
  matchButton.disabled = !artistList.value.trim();
  matchStatus.textContent = '';
});
matchButton.addEventListener('click', () => {
  const { matches, unmatched } = matchArtists(artistList.value, artistCache.names);
  const added = matches.filter((name) => !selected.has(name));
  for (const name of added) selected.add(name);
  if (added.length) {
    renderSelection();
    renderSearch();
    invalidate();
  }
  artistList.value = unmatched.join('\n');
  const messages = [];
  if (added.length) messages.push(added.length + (added.length === 1 ? ' artist added.' : ' artists added.'));
  const duplicates = matches.length - added.length;
  if (duplicates) messages.push(duplicates + ' already selected.');
  if (unmatched.length) {
    messages.push(unmatched.length + (unmatched.length === 1 ? ' name was' : ' names were') +
      ' missing from the synced library. Edit the names above to try again.');
  }
  matchStatus.textContent = messages.join(' ') || 'Paste at least one artist name.';
  if (!unmatched.length) artistList.focus();
  matchButton.disabled = !unmatched.length;
});
clearArtists.addEventListener('click', () => {
  selected.clear();
  renderSelection();
  renderSearch();
  invalidate();
  matchStatus.textContent = '';
  search.focus();
});
cancel.addEventListener('click', () => operation?.abort());
form.addEventListener('change', (event) => {
  if (event.target.id === 'format' || event.target === search || event.target === artistList) return;
  el('custom').hidden = range.value !== 'custom';
  el('date-help').textContent = currentKind() === 'loved'
    ? 'Filters by the date you loved the track, in your browser’s time zone.'
    : 'Dates use your browser’s time zone.';
  invalidate();
});

sync.addEventListener('click', () => run(async (signal) => {
  status.textContent = 'Connecting to Last.fm…';
  while (true) {
    const result = await requestLibrary('/api/artists', signal, 'POST');
    if (result.done) break;
    if (!result.changed) {
      const label = result.initial ? 'Importing all-time artists' : 'Checking new scrobbles';
      status.textContent = label + ' · page ' + result.page + ' of ' + result.total;
    }
    await delay(125, signal);
  }
  artistCache = await requestLibrary('/api/artists', signal);
  status.textContent = numbers.format(artistCache.names.length) + ' artists synced.';
}));

function renderPreview(kind, rows) {
  const table = document.createElement('table');
  const heading = table.createTHead().insertRow();
  const fields = columns[kind];
  for (const field of fields) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = field.replaceAll('_', ' ');
    heading.append(th);
  }
  const body = table.createTBody();
  for (const item of rows.slice(0, 12)) {
    const row = body.insertRow();
    for (const field of fields) row.insertCell().textContent = item[field];
  }
  preview.replaceChildren(table);
  preview.hidden = !rows.length;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const kind = currentKind();
  const format = el('format').value;
  const action = event.submitter?.value ?? 'download';
  run(async (signal) => {
    const window = dates(range.value, el('from').value, el('to').value);
    let rows = action === 'download' ? previousExport?.rows : undefined;
    if (!rows) {
      const collection = collect(kind, window, [...selected]);
      status.textContent = 'Connecting to Last.fm…';
      await readLibrary(kind === 'loved' ? 'loved' : 'scrobbles', kind === 'loved' ? {} : window,
        signal, (items, page, total) => {
          collection.add(items);
          status.textContent = 'Reading Last.fm · page ' + numbers.format(page) + ' of ' + numbers.format(total);
        });
      rows = collection.result();
    }

    if (action === 'preview') {
      previousExport = { rows };
      renderPreview(kind, rows);
      status.textContent = numbers.format(rows.length) + ' matching rows' +
        (rows.length > 12 ? ' · showing the first 12.' : '.');
      return;
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(fileFor(kind, format, rows));
    link.download = 'lastfm-' + kind + '-' + new Date().toISOString().slice(0, 10) + '.' + format;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    previousExport = undefined;
    preview.hidden = true;
    status.textContent = 'Download prepared · ' + numbers.format(rows.length) + ' rows.';
  });
});
