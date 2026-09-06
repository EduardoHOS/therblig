import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { applyPatch, diCoverage, index, parse, placeNew, project, pruneDI } from '../../core/index.mjs';

const corpus = (name) => new URL(`../../../bench/corpus/${name}`, import.meta.url);
const load = async (name) => parse(await readFile(corpus(name), 'utf8'));

// The exemptions and the both-directions check. Each of these was a false refusal on a
// perfectly ordinary file before it was a rule, and each was found by running the corpus
// rather than by a fixture written to pass.

test('a collapsed sub-process does not owe DI for its children', async () => {
  const document = await load('handmade/collapsed-subprocess.bpmn');
  const coverage = diCoverage(document.definitions);
  assert.equal(coverage.ok, true, JSON.stringify(coverage.missing));
  // The five children of the collapsed sub-process are exempt, not counted-and-found.
  assert.equal(coverage.need, 5);
  assert.equal(coverage.missing.length, 0);
});

test('a process no plane draws owes no DI at all', async () => {
  // B.1.0 carries a process referenced by a call activity and never rendered. Demanding
  // shapes for it reported five missing elements and would have refused every edit.
  const document = await load('miwg/B.1.0.bpmn');
  const coverage = diCoverage(document.definitions);
  assert.equal(coverage.ok, true, JSON.stringify(coverage.missing.slice(0, 3)));
});

test('coverage reports a shape left pointing at nothing', async () => {
  const document = await load('handmade/zeebe-roundtrip.bpmn');
  const process = document.definitions.rootElements.find((r) => r.$type === 'bpmn:Process');
  const victim = process.flowElements.findIndex((f) => f.id === 'Review');
  process.flowElements.splice(victim, 1);      // remove behind moddle's back

  const coverage = diCoverage(document.definitions);
  assert.equal(coverage.ok, false);
  assert.ok(coverage.orphans.some((orphan) => orphan.id === 'Review'));
});

test('pruneDI removes exactly the orphans and reports them', async () => {
  const document = await load('handmade/zeebe-roundtrip.bpmn');
  const { changed } = applyPatch(document, [{ op: 'del', id: 'Review' }]);
  assert.ok(changed.includes('Review'));
  // applyPatch prunes already, so a second pass finds nothing left to do.
  assert.deepEqual(pruneDI(document.definitions), []);
  assert.equal(diCoverage(document.definitions).orphans.length, 0);
});

test('placement declines a file that has no diagram at all', async () => {
  const document = await load('handmade/zeebe-roundtrip.bpmn');
  document.definitions.diagrams = [];
  const result = placeNew(document, ['Charge']);
  assert.deepEqual(result.placed, []);
  assert.match(result.reason, /no BPMNPlane/);
});

test('placement declines a container and anything else it cannot position', async () => {
  const document = await load('handmade/zeebe-roundtrip.bpmn');
  // A process, a lane and an id that does not exist: all no-ops, none of them a shape.
  const before = index(document.definitions).size;
  const { placed } = placeNew(document, ['Payment', 'NoSuchElement']);
  assert.deepEqual(placed, []);
  assert.equal(index(document.definitions).size, before);
});

test('a boundary event whose host has no shape is skipped rather than guessed at', async () => {
  const document = await load('handmade/zeebe-roundtrip.bpmn');
  const plane = document.definitions.diagrams[0].plane;
  plane.planeElement = plane.planeElement.filter((di) => di.bpmnElement?.id !== 'Charge');

  applyPatch(document, [
    { op: 'add', type: 'boundary', name: 'Timed out', in: 'Payment', id: 'B1', on: 'Charge', event: 'timer' },
  ]);
  const { placed } = placeNew(document, ['B1']);
  assert.deepEqual(placed, []);
});

test('an edge between vertically aligned shapes takes two waypoints, not four', async () => {
  const document = await load('miwg/C.2.0.bpmn');
  const projection = project(document.definitions);
  const byProcess = new Map();
  for (const node of projection.nodes) {
    if (/task|user|service|manual|send|receive/.test(node.type) && node.in && !byProcess.has(node.in)) {
      byProcess.set(node.in, node);
    }
  }
  const [source, target] = [...byProcess.values()];
  const { created } = applyPatch(document, [{ op: 'message', from: source.id, to: target.id, id: 'MF_V' }]);
  placeNew(document, created);

  const byId = index(document.definitions);
  let waypoints = null;
  for (const diagram of document.definitions.diagrams[0].plane.planeElement) {
    if (diagram.bpmnElement?.id === 'MF_V') waypoints = diagram.waypoint;
  }
  assert.ok(waypoints, 'the message flow got no edge');
  assert.ok(waypoints.length === 2 || waypoints.length === 4);
  assert.ok(byId.get('MF_V'));
});

test('making room moves labels with their shapes and leaves one delta', async () => {
  const document = await load('miwg/C.9.0.bpmn');
  const projection = project(document.definitions);
  const nodes = new Map(projection.nodes.map((n) => [n.id, n]));
  const anchor = projection.flows.find(
    (flow) => /task|user|service/.test(nodes.get(flow.from)?.type ?? '') && nodes.get(flow.to),
  );

  const before = new Map();
  for (const diagram of document.definitions.diagrams[0].plane.planeElement) {
    if (diagram.$type === 'bpmndi:BPMNShape' && diagram.bounds) {
      before.set(diagram.bpmnElement.id, {
        x: diagram.bounds.x,
        labelX: diagram.label?.bounds?.x ?? null,
      });
    }
  }

  const { created } = applyPatch(document, [
    { op: 'add', type: 'user', name: 'Review', in: nodes.get(anchor.from).in, id: 'Cov', between: [anchor.from, anchor.to] },
  ]);
  const { movedShapes } = placeNew(document, ['Cov', ...created]);
  assert.ok(movedShapes > 0, 'this fixture should have had to make room');

  const deltas = new Set();
  for (const diagram of document.definitions.diagrams[0].plane.planeElement) {
    if (diagram.$type !== 'bpmndi:BPMNShape' || !diagram.bounds) continue;
    const was = before.get(diagram.bpmnElement.id);
    if (!was) continue;
    const delta = diagram.bounds.x - was.x;
    if (delta === 0) continue;
    deltas.add(delta);
    if (was.labelX !== null) {
      assert.equal(diagram.label.bounds.x - was.labelX, delta, `${diagram.bpmnElement.id} left its label behind`);
    }
  }
  assert.equal(deltas.size, 1, 'making room is one rigid translation; a relayout scatters');
});

test('making room does not drag the lane band along with the tasks', async () => {
  // A lane's container IS the process, so unlike a pool it survives the container filter
  // and reaches the shape-kind check. It must still not move: a lane left too narrow
  // needs resizing, and translating it would slide the band away from the work it holds.
  const document = await load('miwg/C.1.0.bpmn');
  const projection = project(document.definitions);
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const anchor = projection.flows.find(
    (flow) => /task|user|service/.test(nodes.get(flow.from)?.type ?? '') && nodes.get(flow.to),
  );

  const laneBefore = new Map();
  for (const diagram of document.definitions.diagrams[0].plane.planeElement) {
    if (diagram.bpmnElement?.$type === 'bpmn:Lane' && diagram.bounds) {
      laneBefore.set(diagram.bpmnElement.id, diagram.bounds.x);
    }
  }
  assert.ok(laneBefore.size > 0, 'fixture has no lane shapes');

  const { created } = applyPatch(document, [
    {
      op: 'add', type: 'user', name: 'Wide enough to force a shift',
      in: nodes.get(anchor.from).in, id: 'LaneShift', between: [anchor.from, anchor.to],
    },
  ]);
  placeNew(document, ['LaneShift', ...created]);

  for (const diagram of document.definitions.diagrams[0].plane.planeElement) {
    if (diagram.bpmnElement?.$type !== 'bpmn:Lane' || !diagram.bounds) continue;
    assert.equal(
      diagram.bounds.x,
      laneBefore.get(diagram.bpmnElement.id),
      `lane ${diagram.bpmnElement.id} was translated`,
    );
  }
});
