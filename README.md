# Last.fm Library Exporter

Export scrobbles, artist and album charts, tracks, and loved tracks as CSV or JSON.
Choose a date range and optionally filter by artists from your synced library.
This is an independent, single-user tool that runs on your computer.

## Set up your account

1. Install [Node.js](https://nodejs.org/) 22.16 or newer.
2. Clone this repository or download and extract its ZIP.
3. [Create a Last.fm API account](https://www.last.fm/api/account/create) and copy its **API key**.
4. In this folder, copy `.env.example` to `.env`. Set `LASTFM_USERNAME` to the username
   shown in your Last.fm profile URL and `LASTFM_API_KEY` to your key. The exporter
   uses read-only API methods. Leave your Last.fm password and API shared secret out of the file.
5. Run these commands from the repository folder:

   ```sh
   node build.mjs
   node --env-file=.env serve.mjs
   ```

6. Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Stop the server with Ctrl+C.

The server listens on loopback for use on the same computer. It uses a fixed
username from your local configuration and keeps the key on the server.
`.env` and the local database directory are ignored by Git. Each configured
username gets its own artist index in `.data/`. The app assumes a trusted
local machine and is intended for local use.

## Export

- **Sync artists** imports your all-time artist names the first time. Later syncs
  check newer plays and resume an interrupted run from its last saved page.
  The sync uses play timestamps, so backdated imports before its checkpoint
  fall outside the incremental window.
- Select artists by searching or pasting a comma-separated or newline-separated
  list. Put an artist name containing a comma on its own line. **Clear selected
  artists** restores the all-artist export.
- Choose a type, a date range, and a format. **Preview** fetches the result and
  shows up to 12 rows. Downloading immediately afterward uses that same result.
- Artist, album, and track counts are computed from matching scrobbles. Last.fm's
  own chart groupings can differ. Loved Tracks dates refer to when you loved a
  track. Date filters use your browser's time zone.

Last.fm caps scrobble requests at [200 results per page](https://www.last.fm/api/show/user.getRecentTracks).
Large exports can take several minutes. The exporter fetches every page, retries
temporary failures, and reports errors before offering a file. CSV protects
spreadsheet formula-like text. Use JSON to preserve those strings exactly.

## Develop and test

Run `node build.mjs && node --test`. Tests use synthetic Last.fm responses and
temporary in-memory SQLite. No API key is needed.

- `src/` contains the browser interface, export logic, and server request handler.
- `serve.mjs` runs the exporter locally and `sqlite.mjs` supplies the database adapter.
- `drizzle/` defines the artist index and sync checkpoint schema.
- `test/` covers export logic, pagination, access, and artist sync.

For a manual smoke test, start the app with your own API key, sync artists, then
preview a recent date range with one known artist selected. Verify that every
preview row matches the artist and that CSV or JSON downloads successfully.
