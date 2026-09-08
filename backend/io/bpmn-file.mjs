import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { parse } from '../core/index.mjs';

// The only place in the backend that touches a filesystem. The core stays pure; everything here
// exists so that a failed edit can never reach the user's file.

function outside(path) {
  const error = new Error(`Path "${basename(path)}" is outside the workspace`);
  error.code = 'path-outside-root';
  return error;
}

// realpath resolves symlinks, so a link pointing out of the root is caught by the same check as
// a `..`. The target may not exist yet, so an absent path is confined by its directory.
export async function confine(root, path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const real = await realpath(absolute).catch(async (cause) => {
    if (cause.code !== 'ENOENT') throw cause;
    const parent = await realpath(dirname(absolute));
    // Windows may report ENOENT for file/child, so a resolved parent alone does not
    // establish that the leaf can be created. Confirm the parent is a directory.
    if (!(await stat(parent)).isDirectory()) {
      const error = new Error(`Parent of "${basename(absolute)}" is not a directory`, { cause });
      error.code = 'ENOTDIR';
      throw error;
    }
    return join(parent, basename(absolute));
  });

  const base = await realpath(root);
  if (real !== base && !real.startsWith(base + sep)) throw outside(absolute);
  return real;
}

export async function readBpmn(path, { root }) {
  const confined = await confine(root, path);
  const xml = await readFile(confined, 'utf8');
  return { path: confined, xml, document: await parse(xml) };
}

// Write a sibling temporary file, prove it parses, then rename it over the target. The rename is
// the only step that touches the target, and it is atomic — so a failure anywhere leaves the
// user's file exactly as it was. The temporary goes on every path, including the ones that throw.
export async function writeBpmnAtomic(path, xml, { root }) {
  const confined = await confine(root, path);
  const temporary = join(dirname(confined), `.${basename(confined)}.${process.pid}.tmp`);

  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(xml, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Read back what landed on disk rather than trusting the string we were handed.
    await parse(await readFile(temporary, 'utf8')).catch((cause) => {
      throw new Error(`Refusing to write "${basename(confined)}": the result does not parse`, {
        cause,
      });
    });

    await rename(temporary, confined);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }

  return confined;
}
