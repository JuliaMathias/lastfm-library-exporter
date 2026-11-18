import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import worker from './dist/server/index.js';
import { sqliteBinding } from './sqlite.mjs';

// This entry point is for single-user access on the same computer.
const host = '127.0.0.1';
const port = 4173;
const origin = 'http://' + host + ':' + port;
const username = process.env.LASTFM_USERNAME?.trim();
const apiKey = process.env.LASTFM_API_KEY?.trim();
if (!username || username === 'your_lastfm_username' || !apiKey || apiKey === 'your_lastfm_api_key') {
  console.error('Set LASTFM_USERNAME and LASTFM_API_KEY in .env before starting.');
  process.exit(1);
}

const dataDir = new URL('./.data/', import.meta.url);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const accountHash = createHash('sha256').update(username.toLowerCase()).digest('hex');
const db = new DatabaseSync(fileURLToPath(new URL(accountHash + '.sqlite', dataDir)));
if (db.prepare('PRAGMA user_version').get().user_version === 0) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version === 0) {
      db.exec(readFileSync(new URL('./drizzle/0000_artist_index.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const env = { LASTFM_USERNAME: username, LASTFM_API_KEY: apiKey, DB: sqliteBinding(db) };

const server = createServer(async (incoming, outgoing) => {
  // Reject unexpected Host values to prevent a website from rebinding its hostname to loopback.
  const requestOrigin = incoming.headers.origin;
  if (incoming.headers.host !== host + ':' + port ||
      (requestOrigin && requestOrigin !== origin) ||
      incoming.headers['sec-fetch-site'] === 'cross-site' ||
      !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
    outgoing.writeHead(403).end('Open the exporter from its local address.');
    return;
  }

  try {
    const headers = new Headers({ 'oai-authenticated-user-id': 'local' });
    if (requestOrigin) headers.set('Origin', requestOrigin);
    const request = new Request(origin + incoming.url, { method: incoming.method, headers });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500).end('The local exporter could not finish this request.');
  }
});
server.listen(port, host, () => console.log('Open ' + origin));
