// Root confinement.
//
// The MCP server takes an absolute file path as an ordinary tool argument (ADR-010
// rev. 2), which means the only thing standing between a prompt-injected path and the
// user's private keys is this file. It is written to be boring and checked before it
// is used, and the traversal tests were written before the handler that calls it.
//
// Order matters:
//   1. extension check FIRST, before touching the filesystem at all, so a probe for
//      /etc/shadow is refused without revealing whether it exists;
//   2. realpath BOTH sides, so a symlink inside the root that points outside it is
//      resolved before comparison rather than after;
//   3. path.relative, rejected when it is empty, starts with .., or is absolute.
//
// Case-insensitive on win32, where C:\Users and c:\users are the same directory and a
// case-sensitive compare would let the second escape a root declared as the first.
import { realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import platformPath, { resolve, extname, isAbsolute, parse, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fail } from './errors.mjs';

const ALLOWED_EXT = new Set(['.bpmn', '.xml']);

/** Resolve a root directory once, at server start. */
export async function resolveRoot(dir) {
  const abs = resolve(dir ?? process.cwd());
  if (!existsSync(abs)) fail('THB_NOT_FOUND', `The root ${abs} does not exist.`);
  const real = await realpath(abs);

  // A floor. Everything below depends on the root being a project directory, and the
  // default is the process's cwd — which for a desktop MCP client launched from the
  // shell is frequently `/` or `C:\`. The documented registration string is `--root .`,
  // so the grant is only ever as narrow as wherever the client happened to start. A
  // filesystem root or the user's home directory is never what somebody meant to hand a
  // tool that edits files in place.
  if (parse(real).root === real) {
    fail('THB_OUTSIDE_ROOT',
      `${real} is a filesystem root. Point --root at the project directory that holds the .bpmn files.`);
  }
  if (real === homedir()) {
    fail('THB_OUTSIDE_ROOT',
      `${real} is your home directory. Point --root at the project directory that holds the .bpmn files.`);
  }
  return real;
}

/**
 * Resolve a caller-supplied path against the root, or refuse.
 * @returns {Promise<string>} the real, confined absolute path
 */
export async function confine(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    fail('THB_NOT_FOUND', 'No path was given.');
  }

  // 1 — extension, before any filesystem call.
  if (!ALLOWED_EXT.has(extname(candidate).toLowerCase())) {
    fail('THB_NOT_BPMN', `${candidate} is not a .bpmn or .xml file.`);
  }

  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (!existsSync(abs)) fail('THB_NOT_FOUND', `${candidate} was not found.`);

  // 2 — realpath both sides: a symlink is only safe once it has been followed.
  const realTarget = await realpath(abs);
  const realRoot = await realpath(root);

  // 3 — containment.
  if (!within(realRoot, realTarget)) {
    fail('THB_OUTSIDE_ROOT', `${candidate} resolves outside the root.`);
  }
  return realTarget;
}

/** True when `target` sits underneath root, using the selected platform's path rules. */
export function within(root, target, paths = platformPath) {
  const a = paths === win32 ? root.toLowerCase() : root;
  const b = paths === win32 ? target.toLowerCase() : target;
  const rel = paths.relative(a, b);
  // Empty means target IS the root — a directory, never a file we should open.
  if (rel === '') return false;
  if (paths.isAbsolute(rel)) return false;                 // different drive on win32
  if (rel === '..' || rel.startsWith(`..${paths.sep}`)) return false;
  return true;
}
