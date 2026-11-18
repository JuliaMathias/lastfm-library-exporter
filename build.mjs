import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
const [worker, html, client, css, exporter, artistSync] = await Promise.all(
  ['worker.js', 'index.html', 'client.js', 'style.css', 'exporter.js', 'artist-sync.js'].map(
    (file) => readFile(new URL('src/' + file, import.meta.url), 'utf8'),
  ),
);
const assets = {
  '/': [html, 'text/html'],
  '/client.js': [client, 'text/javascript'],
  '/exporter.js': [exporter, 'text/javascript'],
  '/style.css': [css, 'text/css'],
};
await writeFile('dist/server/index.js', 'const assets = ' + JSON.stringify(assets) + ';\n' + worker + '\n' + artistSync);
