// The only code path that touches a user's file.
//
// Sequence: read bytes → hash → check the revision the caller was given → parse twice
// (one pristine baseline, one working copy) → patch → place → guard → atomic write.
// Two parses rather than the scorer's six, because a barrier that costs a second per
// edit is a barrier somebody turns off.
//
// Nothing is written unless the guard passes. On refusal the file on disk is not
// opened for writing at all, so "refused" and "byte-identical" are the same statement.
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { parse, serialize } from '../core/document.mjs';
import { applyPatch } from '../core/patch.mjs';
import { placeNew } from '../core/placement.mjs';
import { assertSafe } from './guard.mjs';
import { readWithRev, revOf } from './rev.mjs';
import { TherbligError } from './errors.mjs';

/**
 * Map a core error message onto the agent-facing taxonomy.
 *
 * Matching on message text is not lovely, and the alternative — typed errors inside
 * backend/core — would push io's concerns into a module that has no I/O and no callers
 * to serve them to. The translation lives on this side of the boundary instead, where
 * being wrong costs a less specific code rather than a wrong answer.
 */
function codeForPatchError(message) {
  if (/cannot be set directly/i.test(message)) return 'THB_FORBIDDEN_FIELD';
  if (/is not settable/i.test(message)) return 'THB_FORBIDDEN_FIELD';
  if (/not found/i.test(message)) return 'THB_NOT_FOUND_ELEMENT';
  if (/^Unknown operation|is a \w+, not a lane|needs a "lane"|no collaboration/i.test(message)) {
    return 'THB_UNKNOWN_TYPE';
  }
  return 'THB_UNKNOWN_TYPE';
}

/**
 * Replace a file's contents atomically.
 *
 * Write to a temp file in the SAME directory — rename is only atomic within a
 * filesystem — then rename over the target. A reader therefore sees either the old
 * bytes or the new ones, never a partial write, which is what makes an interrupted
 * edit safe.
 *
 * The retry loop is for Windows specifically. NTFS refuses a rename while another
 * process holds the target open, and for a .bpmn the common holders are exactly the
 * ones our users run: Camunda Modeler with the file open, OneDrive mid-sync, or an
 * antivirus scanning a file that just changed. These are transient, so backing off
 * briefly turns a hard failure into a pause.
 */
export async function atomicWrite(absPath, contents, { retries = 5 } = {}) {
  const tmp = join(dirname(absPath), `.${basename(absPath)}.${process.pid}.tmp`);
  await writeFile(tmp, contents, 'utf8');
  let delay = 20;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, absPath);
      return;
    } catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!transient || attempt >= retries) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/**
 * Apply operations to a file.
 *
 * @param {string} absPath   already confined by paths.mjs
 * @param {object[]} ops
 * @param {{baseRev?: string, dryRun?: boolean}} options
 */
export async function applyToFile(absPath, ops, { baseRev = null, dryRun = false } = {}) {
  const { xml, rev } = await readWithRev(absPath);

  // A write must name the revision it was built against. Not for the usual optimistic
  // -concurrency reason — there is no server holding state — but because the file may
  // have been saved from a modeller since the model read it, and overwriting that
  // silently is the single worst thing this tool could do.
  if (!dryRun) {
    if (!baseRev) throw new TherbligError('THB_REV_REQUIRED');
    if (baseRev !== rev) {
      throw new TherbligError('THB_STALE_REV', `You read ${baseRev}; the file is now ${rev}.`);
    }
  } else if (baseRev && baseRev !== rev) {
    throw new TherbligError('THB_STALE_REV', `You read ${baseRev}; the file is now ${rev}.`);
  }

  // Two independent trees. applyPatch mutates in place, so the working copy cannot
  // also serve as the baseline the guard compares against.
  const pristine = (await parse(xml)).definitions;
  const working = await parse(xml);

  // backend/core throws plain Errors, which is its convention and none of io's business
  // to change. But an agent on the other side of MCP needs a code to branch on rather
  // than a sentence to regex, so the taxonomy is applied here, at the boundary where it
  // is actually consumed. Core stays unaware of it.
  let changed, created;
  try {
    ({ changed, created } = applyPatch(working, ops));
  } catch (error) {
    if (error instanceof TherbligError) throw error;
    throw new TherbligError(codeForPatchError(error.message), error.message);
  }
  const touched = [...new Set([...changed, ...created])];
  placeNew(working, touched);
  const after = await serialize(working);

  const verdict = assertSafe(pristine, working.definitions, {
    ops, created, beforeXml: xml, afterXml: after,
  });

  const result = {
    path: absPath,
    base_rev: rev,
    created,
    changed,
    declared: verdict.expected,
    written: false,
    refused: !verdict.ok,
    diagnostics: verdict.diagnostics,
    // Both versions, so a caller can build a receipt or draw the diff without redoing
    // the work. On a refusal the after-state is still returned: seeing exactly what was
    // rejected is more useful than being told it was.
    before_xml: xml,
    after_xml: after,
  };

  if (!verdict.ok || dryRun) return result;

  await atomicWrite(absPath, after);
  result.written = true;
  result.new_rev = revOf(Buffer.from(after, 'utf8'));
  return result;
}
