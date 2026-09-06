// The preservation receipt.
//
// An edit that says "nothing else changed" is asking to be trusted. A receipt is that
// claim written down in a form somebody else can check — offline, deterministically,
// with no API key and no network — against the two files it describes.
//
// It is deliberately re-derivable rather than signed. A signature proves therblig wrote
// the receipt; re-derivation proves the receipt is TRUE, which is the part that matters
// and the part a reviewer can check without trusting us at all.
import { parse } from './model.mjs';
import { semanticDiffTrees, headline } from './diff.mjs';
import { geometry } from './diff.mjs';
import { renderTree } from './render/svg.mjs';
import { revOf } from './rev.mjs';
import { inspectTree } from './oracle/inspect.mjs';
import { message } from './oracle/invariants.mjs';

export const RECEIPT_VERSION = 1;

/**
 * Build a receipt for an edit.
 * @param {string} beforeXml the bytes as they were
 * @param {string} afterXml  the bytes as they are
 */
export async function buildReceipt(beforeXml, afterXml, { file = null, ops = [], declared = [], written = false, refused = false } = {}) {
  const before = (await parse(beforeXml)).definitions;
  const after = (await parse(afterXml)).definitions;
  const diff = semanticDiffTrees(before, after, { declared, beforeXml, afterXml });
  const introduced = newDiagnostics(before, after);

  return {
    receipt: RECEIPT_VERSION,
    file,
    before_rev: revOf(Buffer.from(beforeXml, 'utf8')),
    after_rev: revOf(Buffer.from(afterXml, 'utf8')),
    ops,
    declared,
    written,
    refused,
    headline: headline(diff),
    diff,
    introduced_diagnostics: introduced,
  };
}

// Only what this edit ADDED. A file that already had a warning keeps it, and holding
// that against the edit is the mistake ADR-006 identified for lint presets.
function newDiagnostics(before, after) {
  const key = (d) => `${d.code}:${d.elements.join('|')}`;
  const had = new Set(inspectTree(before).map(key));
  return inspectTree(after)
    .filter((d) => !had.has(key(d)))
    .map((d) => ({ code: d.code, severity: d.severity, elements: d.elements, message: message(d) }));
}

/**
 * Re-derive a receipt's numbers from the two files and report any disagreement.
 * Everything here is local and deterministic; a stranger with the repo and no key can
 * run it and get the same answer.
 */
export async function verifyReceipt(receipt, beforeXml, afterXml) {
  const problems = [];
  const beforeRev = revOf(Buffer.from(beforeXml, 'utf8'));
  const afterRev = revOf(Buffer.from(afterXml, 'utf8'));

  if (receipt.before_rev !== beforeRev) problems.push(`before_rev claims ${receipt.before_rev}, the file hashes to ${beforeRev}`);
  if (receipt.after_rev !== afterRev) problems.push(`after_rev claims ${receipt.after_rev}, the file hashes to ${afterRev}`);
  if (problems.length) return { ok: false, problems, checked: 0 };

  const before = (await parse(beforeXml)).definitions;
  const after = (await parse(afterXml)).definitions;
  const fresh = semanticDiffTrees(before, after, { declared: receipt.declared ?? [], beforeXml, afterXml });

  // Compare the load-bearing numbers one at a time, so a failure names which claim was
  // wrong rather than reporting that two large objects differ.
  const claims = [
    ['added', receipt.diff.semantic.added.length, fresh.semantic.added.length],
    ['removed', receipt.diff.semantic.removed.length, fresh.semantic.removed.length],
    ['changed', receipt.diff.semantic.changed.length, fresh.semantic.changed.length],
    ['rewired', receipt.diff.semantic.rewired.length, fresh.semantic.rewired.length],
    ['shapesMoved', receipt.diff.layout.shapesMoved, fresh.layout.shapesMoved],
    ['distinctDeltas', receipt.diff.layout.distinctDeltas, fresh.layout.distinctDeltas],
    ['labelsDetached', receipt.diff.layout.labelsDetached, fresh.layout.labelsDetached],
    ['waypointsMoved', receipt.diff.layout.waypointsMoved, fresh.layout.waypointsMoved],
    ['protectedObjects.total', receipt.diff.protectedObjects.total, fresh.protectedObjects.total],
    ['unintendedChanges', receipt.diff.protectedObjects.unintendedChanges, fresh.protectedObjects.unintendedChanges],
    ['ucr', receipt.diff.protectedObjects.ucr, fresh.protectedObjects.ucr],
  ];
  for (const [name, claimed, actual] of claims) {
    if (claimed !== actual) problems.push(`${name}: receipt says ${claimed}, the files say ${actual}`);
  }

  return { ok: problems.length === 0, problems, checked: claims.length, derived: fresh };
}

/**
 * A diff drawing: the after-state, with what changed picked out and ghosts where moved
 * shapes used to be.
 *
 * Colour follows the brand brief rather than the usual green/red/amber. The palette has
 * no green or amber, its audit is explicit that inventing colours is a violation, and
 * signal is reserved for the validator — a removal you asked for is not an error. So
 * added is ink at full weight, moved leaves a pencil ghost behind, and everything the
 * edit did not touch recedes to rule so the eye goes straight to what moved.
 */
export async function renderDiff(beforeXml, afterXml, { title = null, flagged = [] } = {}) {
  const before = (await parse(beforeXml)).definitions;
  const after = (await parse(afterXml)).definitions;
  const ga = geometry(before), gb = geometry(after);

  const added = new Set([...gb.keys()].filter((id) => !ga.has(id)));
  const removed = new Set([...ga.keys()].filter((id) => !gb.has(id)));
  const moved = new Set();
  const ghosts = [];
  for (const [id, was] of ga) {
    const now = gb.get(id);
    if (!now) { ghosts.push(was); continue; }
    if (Math.round(now.x - was.x) || Math.round(now.y - was.y)) {
      moved.add(id);
      ghosts.push(was);
    }
  }
  return renderTree(after, {
    title, diff: { added, removed, moved, ghosts, flagged: new Set(flagged) },
  });
}
