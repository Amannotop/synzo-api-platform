/**
 * Serves the built dashboard over HTTP for the local preview agent.
 *
 * The API already serves the dashboard in the deployment that matters
 * (SERVE_DASHBOARD=true, single origin). This exists for the case where the
 * API is not serving it: a frontend developer running the API and the SPA
 * separately, who still wants a stable local port.
 *
 * It is deliberately dependency-free and about forty lines. The alternative
 * was running `vite preview` under launchd, which needs a package manager on
 * a PATH that launchd does not have, and which supervises a toolchain rather
 * than serving files. The build is a release step; this only serves it.
 *
 * Usage: node scripts/serve-dashboard.mjs <dist-dir> [port]
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'apps/dashboard/dist');
const port = Number(process.argv[3] ?? 5173);

if (!existsSync(join(root, 'index.html'))) {
  console.error(`No dashboard build at ${root}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  // Confine every request to the dist directory. normalize collapses `..`
  // segments, and the prefix check rejects anything that climbed out -- the
  // reason a static file server that skips this is a file disclosure bug.
  const target = normalize(join(root, decodeURIComponent(path)));
  if (target !== root && !target.startsWith(root + sep)) {
    return send(res, 403, 'Forbidden');
  }

  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, 'index.html');
  }
  // A client-side route like /usage is not a file; the SPA resolves it, so
  // index.html is served with 200 or a hard refresh breaks.
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(root, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'Not found');
  }

  const isEntry = file.endsWith('index.html');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': isEntry ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard preview on http://127.0.0.1:${port} (serving ${root})`);
});
