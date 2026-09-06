// Every invariant, on every file in the corpus, with no API key and no network.
//
// The point is coverage of REAL files rather than of a fixture chosen to pass. Each
// file gets whichever of the canonical edits its own contents can express — a corpus of
// nine exporters does not contain the same shapes twice — and every edit is then held
// to the same invariants:
//
//   parses · XSD-valid · no NEW error diagnostic · distinctDeltas <= 1 ·
//   labelsDetached 0 · no orphaned DI · the receipt re-derives
//
// All eight canonical edits now, including the two that needed new operations: lane
// membership lives on the lane rather than the node, and only a message flow may cross
// a pool boundary. A file only gets the edits its own contents can express — a corpus
// of nine exporters does not contain the same shapes twice — and the per-kind counts
// below say which ran, so a category quietly reaching zero files is visible.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse, serialize } from '../packages/therblig/src/model.mjs';
import { project } from '../packages/therblig/src/ir.mjs';
import { applyPatch } from '../packages/therblig/src/patch.mjs';
import { placeNew, diCoverage } from '../packages/therblig/src/place.mjs';
import { parses, xsdValid } from '../packages/therblig/src/validate.mjs';
import { inspectTree } from '../packages/therblig/src/oracle/inspect.mjs';
import { message } from '../packages/therblig/src/oracle/invariants.mjs';
import { expectedFromOps } from '../packages/therblig/src/guard.mjs';
import { semanticDiffTrees } from '../packages/therblig/src/diff.mjs';
import { buildReceipt, verifyReceipt } from '../packages/therblig/src/receipt.mjs';

const root = process.argv[2] || 'bench/corpus';
const files = (function walkDir(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    statSync(p).isDirectory() ? walkDir(p, out) : e.endsWith('.bpmn') && out.push(p);
  }
  return out;
})(root).sort();

const TASKY = /^(task|user|service|manual|send|receive|script|rule)$/;

/** Pick the edits this particular file can actually express. */
function plan(ir) {
  const nodes = new Map((ir.nodes ?? []).map((n) => [n.id, n]));
  const flows = ir.flows ?? [];
  const out = [];

  // insert into a sequence
  const between = flows.find((f) => TASKY.test(nodes.get(f.from)?.type ?? '') && nodes.get(f.to));
  if (between) {
    out.push({
      kind: 'insert',
      ops: [{ op: 'add', type: 'user', name: 'Sweep insert', in: nodes.get(between.from).in, id: 'SweepInsert', between: [between.from, between.to] }],
    });
  }

  // rename something referenced downstream
  const named = (ir.nodes ?? []).find((n) => n.name && TASKY.test(n.type));
  if (named) out.push({ kind: 'rename', ops: [{ op: 'set', id: named.id, patch: { name: `${named.name} (swept)` } }] });

  // a boundary event on a task
  const host = (ir.nodes ?? []).find((n) => TASKY.test(n.type));
  if (host) {
    out.push({
      kind: 'boundary',
      ops: [{ op: 'add', type: 'boundary', name: 'Timed out', in: host.in, id: 'SweepBoundary', on: host.id, event: 'timer' }],
    });
  }

  // split a path on a condition
  if (between) {
    out.push({
      kind: 'split',
      ops: [
        { op: 'add', type: 'xor', name: 'Sweep gate?', in: nodes.get(between.from).in, id: 'SweepGate', between: [between.from, between.to] },
        { op: 'set', id: 'SweepGate', patch: { name: 'Sweep gate?' } },
      ],
    });
  }

  // an edit scoped INSIDE a sub-process, when the file has one with contents
  const sub = (ir.nodes ?? []).find((n) => n.type === 'subprocess'
    && (ir.nodes ?? []).some((c) => c.in === n.id));
  if (sub) {
    const inner = flows.find((f) => nodes.get(f.from)?.in === sub.id && nodes.get(f.to)?.in === sub.id);
    if (inner) {
      out.push({
        kind: 'subprocess',
        ops: [{ op: 'add', type: 'user', name: 'Inner step', in: sub.id, id: 'SweepInner', between: [inner.from, inner.to] }],
      });
    }
  }

  // delete a node — no heal yet, so only where the node is a leaf-ish task
  const victim = (ir.nodes ?? []).find((n) => TASKY.test(n.type)
    && flows.filter((f) => f.to === n.id).length === 1
    && flows.filter((f) => f.from === n.id).length === 1);
  if (victim) out.push({ kind: 'delete', ops: [{ op: 'del', id: victim.id }] });

  // move a node to another lane — only where the file has two lanes and a node in one
  const laned = (ir.nodes ?? []).find((n) => n.lane && TASKY.test(n.type));
  const otherLane = laned && (ir.lanes ?? []).find((l) => l.id !== laned.lane);
  if (laned && otherLane) out.push({ kind: 'move', ops: [{ op: 'move', id: laned.id, lane: otherLane.id }] });

  // a message flow between two pools — only where two processes both hold work
  const byProcess = new Map();
  for (const n of ir.nodes ?? []) {
    if (!TASKY.test(n.type) || !n.in) continue;
    if (!byProcess.has(n.in)) byProcess.set(n.in, n);
  }
  if ((ir.pools ?? []).length >= 2 && byProcess.size >= 2) {
    const [p, q] = [...byProcess.values()];
    out.push({ kind: 'message', ops: [{ op: 'message', from: p.id, to: q.id, name: 'Sweep message', id: 'SweepMessage' }] });
  }

  return out;
}

let ran = 0, failed = 0, worstDeltas = 0, labelsDetached = 0, orphans = 0;
const byKind = {};
const problems = [];

for (const file of files) {
  const beforeXml = readFileSync(file, 'utf8');
  const short = file.split(sep).join('/').replace(`${root}/`, '');
  const baseTree = (await parse(beforeXml)).definitions;
  const baseline = new Set(inspectTree(baseTree).map((d) => `${d.code}:${d.elements.join('|')}`));

  for (const step of plan(project(baseTree))) {
    ran++;
    byKind[step.kind] = (byKind[step.kind] ?? 0) + 1;
    const label = `${short} · ${step.kind}`;
    try {
      const doc = await parse(beforeXml);
      const pristine = (await parse(beforeXml)).definitions;
      const { changed, created } = applyPatch(doc, step.ops);
      placeNew(doc, [...new Set([...changed, ...created])]);
      const afterXml = await serialize(doc);
      const declared = [...expectedFromOps(step.ops, pristine, created)];

      const p = await parses(afterXml);
      if (!p.ok) { problems.push(`${label}: does not parse — ${p.error}`); failed++; continue; }
      const x = await xsdValid(afterXml);
      if (!x.ok) { problems.push(`${label}: not XSD-valid — ${(x.errors[0] ?? '').slice(0, 90)}`); failed++; continue; }

      const introduced = inspectTree(doc.definitions)
        .filter((d) => !baseline.has(`${d.code}:${d.elements.join('|')}`) && d.severity === 'error');
      if (introduced.length) {
        problems.push(`${label}: introduced ${introduced.length} error — ${message(introduced[0])}`);
        failed++; continue;
      }

      const cov = diCoverage(doc.definitions);
      if (cov.orphans.length) { orphans += cov.orphans.length; problems.push(`${label}: ${cov.orphans.length} orphaned DI`); failed++; continue; }
      if (cov.missing.length) { problems.push(`${label}: ${cov.missing.length} elements without DI`); failed++; continue; }

      const d = semanticDiffTrees(pristine, doc.definitions, { declared, beforeXml, afterXml });
      worstDeltas = Math.max(worstDeltas, d.layout.distinctDeltas);
      labelsDetached += d.layout.labelsDetached;
      if (d.layout.distinctDeltas > 1) { problems.push(`${label}: ${d.layout.distinctDeltas} distinct deltas — the diagram reflowed`); failed++; continue; }
      if (d.layout.labelsDetached) { problems.push(`${label}: ${d.layout.labelsDetached} labels left behind`); failed++; continue; }
      if (d.protectedObjects.unintendedChanges) {
        problems.push(`${label}: ${d.protectedObjects.unintendedChanges} of ${d.protectedObjects.total} protected objects changed`);
        failed++; continue;
      }

      const rec = await buildReceipt(beforeXml, afterXml, { file: short, ops: step.ops, declared });
      const v = await verifyReceipt(rec, beforeXml, afterXml);
      if (!v.ok) { problems.push(`${label}: receipt does not re-derive — ${v.problems[0]}`); failed++; continue; }
    } catch (e) {
      problems.push(`${label}: threw — ${e.message.slice(0, 110)}`);
      failed++;
    }
  }
}

console.log(`corpus sweep: ${ran - failed}/${ran} edits across ${files.length} files`);
console.log(`  by kind: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
console.log(`  worst distinctDeltas ${worstDeltas}, labels detached ${labelsDetached}, orphan DI ${orphans}`);
if (problems.length) {
  console.log('\nproblems:');
  for (const p of problems.slice(0, 25)) console.log(`  ${p}`);
  if (problems.length > 25) console.log(`  … and ${problems.length - 25} more`);
}
process.exit(failed ? 1 : 0);
