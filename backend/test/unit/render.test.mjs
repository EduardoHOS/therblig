import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPatch,
  changesFrom,
  parse,
  placeNew,
  project,
  render,
  serialize,
} from '../../core/index.mjs';
import { normalizedFixture, readFixture } from '../support/fixture.mjs';

const claim = async () => (await parse(await readFixture('handmade/parallel-join.bpmn'))).definitions;

test('every element that has DI is drawn, in the shape its block declares', async () => {
  const definitions = await claim();
  const svg = render(definitions, { title: 'claim' });
  const ir = project(definitions);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Two parallel gateways and one exclusive are diamonds; the tasks are rectangles; the start and
  // end are circles. Nothing is laid out here — every coordinate came from the document.
  assert.equal((svg.match(/<polygon/g) ?? []).length, 3, 'three gateways');
  // Rounded corners are what makes an activity an activity; the one square rect is the ground.
  assert.equal((svg.match(/<rect [^>]*rx="8"/g) ?? []).length, 4, 'four activities');
  assert.equal((svg.match(/<circle/g) ?? []).length, 2, 'a start and an end');
  assert.equal((svg.match(/<polyline/g) ?? []).length, ir.flows.length);
  assert.match(svg, /Check fraud/, 'labels come from the model');
});

test('a document with no DI says so instead of drawing an empty picture', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P"><bpmn:task id="t" name="t"/></bpmn:process>
</bpmn:definitions>`;

  const svg = render((await parse(xml)).definitions);

  assert.match(svg, /carries no DI/);
  assert.doesNotMatch(svg, /<rect x=/);
});

test('what changed is coloured, and each kind gets its own colour', async () => {
  const { document, normalized } = await normalizedFixture();
  const { created } = applyPatch(document, [
    { op: 'add', type: 'user', name: 'Verify', id: 'Verify', in: 'Payment', between: ['Charge', 'Review'] },
    { op: 'set', id: 'Review', patch: { name: 'Review it' } },
  ]);
  placeNew(document, created);
  const after = await serialize(document);

  const changed = await changesFrom(normalized, after);
  assert.equal(changed.Verify, 'added');
  assert.equal(changed.Flow_2, 'rerouted');
  assert.equal(changed.Review, 'renamed');

  const svg = render((await parse(after)).definitions, { changed });
  assert.match(svg, /#2C7449/, 'added is green');
  assert.match(svg, /#7E6417/, 'rerouted is amber');
  assert.match(svg, /#0E6B60/, 'renamed is teal');
});

test('a label is wrapped and clipped rather than spilling out of its box', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    {
      op: 'set',
      id: 'Charge',
      patch: { name: 'Charge the card and then wait for the acquirer to settle the transaction fully' },
    },
  ]);

  const svg = render(document.definitions);
  const inside = svg.match(/<text[^>]*>([^<]*)<\/text>/g) ?? [];

  assert.ok(inside.length >= 3, 'the long name became several lines');
  assert.ok(inside.every((line) => line.replace(/<[^>]*>/g, '').length <= 20), inside.join('|'));
});

test('a name with markup in it cannot escape the document', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [{ op: 'set', id: 'Charge', patch: { name: '<script>&"x"' } }]);

  const svg = render(document.definitions);

  assert.match(svg, /&lt;script&gt;&amp;&quot;x&quot;/);
  assert.doesNotMatch(svg, /<script>/);
});

test('an intermediate event is drawn with its double ring, a plain gateway without a marker', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:intermediateCatchEvent id="wait" name="Wait"><bpmn:timerEventDefinition/></bpmn:intermediateCatchEvent>
    <bpmn:inclusiveGateway id="maybe" name="Maybe" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="P">
    <bpmndi:BPMNShape id="S_wait" bpmnElement="wait"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_maybe" bpmnElement="maybe"><dc:Bounds x="200" y="93" width="50" height="50"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const svg = render((await parse(xml)).definitions);

  // A catch event is a ring inside a ring, which is how a reader tells it from a start event.
  assert.equal((svg.match(/<circle/g) ?? []).length, 2, 'one event, drawn twice');
  // An inclusive gateway has a marker this renderer does not draw; the diamond still has to be
  // there, rather than the element vanishing.
  assert.equal((svg.match(/<polygon/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /stroke-width="2"\/>/, 'no exclusive or parallel marker');
});

test('a collaboration with no flow nodes still produces a picture of what it has', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="C">
    <bpmn:participant id="Them" name="Supplier" />
    <bpmn:participant id="Us" name="Us" />
    <bpmn:messageFlow id="Order" name="order" sourceRef="Us" targetRef="Them" />
  </bpmn:collaboration>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="C">
    <bpmndi:BPMNShape id="S_Them" bpmnElement="Them" isHorizontal="true"><dc:Bounds x="100" y="60" width="300" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Us" bpmnElement="Us" isHorizontal="true"><dc:Bounds x="100" y="200" width="300" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E_Order" bpmnElement="Order"><di:waypoint x="250" y="200"/><di:waypoint x="250" y="140"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  // Two black-box pools and a message between them: the projection reports no nodes at all, and
  // the picture is the message that does exist rather than the "no DI" apology.
  const svg = render((await parse(xml)).definitions);

  assert.doesNotMatch(svg, /carries no DI/);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 1, 'the message flow is drawn');
  assert.equal((svg.match(/<rect [^>]*rx="8"/g) ?? []).length, 0, 'a pool is not an activity');
});
