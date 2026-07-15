import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'prototype', 'mini-app');
const port = Number(process.env.PROTOTYPE_PORT ?? 4173);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PROTOTYPE_PORT must be an integer between 1 and 65535');
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://prototype.local');
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === '/' || pathname === '/mini-app'
    ? 'index.html'
    : pathname.replace(/^\/mini-app\/?/u, '').replace(/^\/+/, '');
  const filePath = resolve(root, relativePath);
  if (
    !filePath.startsWith(`${root}${sep}`) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mini App prototype: http://127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
