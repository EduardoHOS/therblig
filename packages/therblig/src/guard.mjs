// The barrier every write passes through.
//
// Two design points, both learned the hard way.
//
// 1. It takes ALREADY-PARSED trees. bench/scorer/gates.mjs::scoreAll re-parses the
//    document six times (parses ×1, lintClean ×3, fingerprint ×2) and runs bpmnlint
//    four times, which on the 241 KB C.8.0 is most of a second spent before any
//    checking begins. A barrier that slow gets turned off.
//
// 2. The expected set is derived from the OPERATIONS, not from applyPatch's report of
//    what it changed. Letting applyPatch declare its own blast radius means it grades
//    its own homework: if it under-reports, the guard is blind to exactly the case it
//    exists for. The ops are the user's stated intent; applyPatch's mutation is the
//    effect; the guard compares one against the other.
import { walk } from './model.mjs';
import { compareTrees } from './oracle/compare.mjs';
import { blocking } from './oracle/compare.mjs';

/**
 * Ids an operation legitimately touches, read off the operation itself.
 *
 * A splice — "put X between A and B" — also retargets the existing A→B flow, whose id
 * the user never named. That flow is incident to a named node, so it is expected. A
 * flow incident to nothing the user mentioned is not, and that is the case worth
 * catching.
 */
export function expectedFromOps(ops, beforeTree, created = []) {
  const named = new Set(created);
  for (const op of ops) {
    for (const k of ['id', 'in', 'from', 'to', 'on', 'after']) {
      if (typeof op[k] === 'string') named.add(op[k]);
    }
    if (Array.isArray(op.between)) for (const v of op.between) if (typeof v === 'string') named.add(v);
  }

  // Flows incident to a named node, boundary events attached to one, and any lane that
  // lists one. A lane is the third case and the least obvious: deleting a task really
  // does shrink the lane that held it, and refusing that would be a false positive on
  // the most ordinary edit there is.
  const incident = new Set();
  for (const el of walk(beforeTree)) {
    if (!el.id) continue;
    const src = el.sourceRef?.id, tgt = el.targetRef?.id, host = el.attachedToRef?.id;
    if ((src && named.has(src)) || (tgt && named.has(tgt)) || (host && named.has(host))) incident.add(el.id);
    if (el.$type === 'bpmn:Lane' && (el.flowNodeRef || []).some((r) => r?.id && named.has(r.id))) {
      incident.add(el.id);
    }
  }
  return new Set([...named, ...incident]);
}

/**
 * @param {object} beforeTree pristine definitions, parsed from the bytes on disk
 * @param {object} afterTree  the mutated definitions
 * @returns {{ok: boolean, diagnostics: object[], blockers: object[], expected: string[]}}
 */
export function assertSafe(beforeTree, afterTree, { ops = [], created = [], beforeXml, afterXml } = {}) {
  const expected = expectedFromOps(ops, beforeTree, created);
  const diagnostics = compareTrees(beforeTree, afterTree, {
    expectedIds: [...expected], beforeXml, afterXml,
  });
  const blockers = blocking(diagnostics);
  return { ok: blockers.length === 0, diagnostics, blockers, expected: [...expected] };
}

export { blocking };
