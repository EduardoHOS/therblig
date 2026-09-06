#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * The Studio, restarted whenever the core it imports changes.
 *
 * Three measured facts shape this. `next dev` does not pick up an edit under `backend/`: the core
 * is loaded through `serverExternalPackages`, so Node caches it for the life of the process and the
 * page keeps serving the old drawing. Node's own `--watch-path` cannot be the thing that restarts
 * it: running `next dev` underneath it breaks Next's worker IPC, and every request logs several
 * hundred `Unexpected response from worker` exceptions over a page that renders fine. And `npm` is
 * not reliably on PATH — a version manager that shims only `node` is enough for `spawn npm` to
 * fail with ENOENT — so this runs Next's own CLI under the Node already running this file.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const studio = new URL('frontend/', new URL(root, 'file:'));
const port = process.env.PORT ?? '3000';

let next;
try {
  next = createRequire(new URL('package.json', studio)).resolve('next/dist/bin/next');
} catch {
  process.stderr.write('The Studio is not installed. Run `make install` first.\n');
  process.exit(1);
}

let child = null;
let leaving = false;
let pending = null;

function start() {
  child = spawn(process.execPath, [next, 'dev', '--port', port], {
    cwd: fileURLToPath(studio),
    stdio: 'inherit',
    env: { ...process.env, TREADLE_WORKSPACE: process.env.TREADLE_WORKSPACE ?? root },
  });
  const spawned = child;
  child.on('error', (error) => {
    process.stderr.write(`Cannot start the Studio: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (leaving || spawned !== child) return;
    process.exit(signal ? 1 : (code ?? 0));
  });
}

function restart() {
  const dying = child;
  child = null;
  dying.once('exit', () => {
    process.stderr.write('\n↻ backend changed — restarting the Studio\n');
    start();
  });
  dying.kill('SIGTERM');
}

// One restart per burst: an editor writing a file fires several events, and a save should not
// queue several dev servers onto the same port.
watch(new URL('backend/', new URL(root, 'file:')), { recursive: true }, (_event, name) => {
  if (!name?.endsWith('.mjs') || !child) return;
  clearTimeout(pending);
  pending = setTimeout(restart, 150);
});

const stop = () => {
  leaving = true;
  child?.kill('SIGTERM');
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
process.on('exit', stop);

start();
