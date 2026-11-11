import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist', 'pages');
const pages = ['index', 'detail', 'orders', 'profile', 'recharge', 'rules', 'showcase', 'winners', 'admin', 'login'];
const files = pages.map(p => p + '.html');
for (const directory of ['css', 'js']) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.' + directory)) files.push(directory + '/' + entry.name);
  }
}
await mkdir(out, { recursive: true });
const allowed = new Set([...pages.map(p => p + '.html'), 'css', 'js', '_worker.js', '_headers', '_routes.json']);
for (const entry of await readdir(out)) {
  if (!allowed.has(entry)) throw new Error(`Unexpected build output: ${entry}. Refusing to publish.`);
}
for (const file of files) {
  await mkdir(path.dirname(path.join(out, file)), { recursive: true });
  await copyFile(path.join(root, file), path.join(out, file));
}
await copyFile(path.join(root, 'deploy/pages-worker.mjs'), path.join(out, '_worker.js'));
await writeFile(path.join(out, '_routes.json'), JSON.stringify({ version: 1, include: ['/api', '/api/*', '/uploads/*'], exclude: [] }));
await writeFile(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-cache\n');
console.log(`Built ${files.length} public files in ${out}; no backend, credentials or database files included.`);
