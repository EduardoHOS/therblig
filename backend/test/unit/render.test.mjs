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
  // Only the outlines are counted: a mark inside a shape is drawn with circles too.
  assert.equal((svg.match(/<circle data-id=/g) ?? []).length, 2, 'a start and an end');
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

test('an intermediate event is drawn with its double ring, and every gateway wears its mark', async () => {
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
  assert.equal(
    (svg.match(/<circle/g) ?? []).length,
    4,
    'two rings, the timer face, and the inclusive gateway',
  );
  assert.equal((svg.match(/<circle data-id=/g) ?? []).length, 1, 'one event');
  assert.match(svg, /data-glyph="timer"/, 'the kind it waits for');
  // An inclusive gateway is a diamond around a circle. Without the mark, all five gateways are the
  // same shape and a reader cannot tell a choice from a race.
  assert.equal((svg.match(/<polygon/g) ?? []).length, 1);
  assert.match(svg, /data-glyph="or"/);
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

test('every drawn element carries its id, so a reader can say which shape is which', async () => {
  const definitions = await claim();
  const svg = render(definitions);
  const ir = project(definitions);

  const tagged = new Set([...svg.matchAll(/data-id="([^"]+)"/g)].map((match) => match[1]));
  for (const element of [...ir.nodes, ...ir.flows]) {
    assert.ok(tagged.has(element.id), `${element.id} is drawn but not identified`);
  }
  assert.match(svg, /data-kind="xor"/);
  assert.match(svg, /data-kind="flow"/);
});

test('a label sits where the DI puts it, and clear of the shape when the DI is silent', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="placed" name="Application received" />
    <bpmn:endEvent id="bare" name="Timeout" />
    <bpmn:task id="work" name="Get credit score" />
    <bpmn:task id="anon" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="P">
    <bpmndi:BPMNShape id="S_placed" bpmnElement="placed"><dc:Bounds x="100" y="100" width="36" height="36"/>
      <bpmndi:BPMNLabel><dc:Bounds x="90" y="142" width="80" height="27"/></bpmndi:BPMNLabel></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_bare" bpmnElement="bare"><dc:Bounds x="300" y="100" width="36" height="36"/>
      <bpmndi:BPMNLabel /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_work" bpmnElement="work"><dc:Bounds x="400" y="80" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_anon" bpmnElement="anon"><dc:Bounds x="540" y="80" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const svg = render((await parse(xml)).definitions);
  const texts = [...svg.matchAll(/<text[^>]* x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(
    (match) => ({ x: Number(match[1]), y: Number(match[2]), text: match[3] }),
  );
  const of = (word) => texts.filter((entry) => entry.text.includes(word));

  // The DI says this label is a 80-wide box under the event, centred at x=130 — not at the
  // event's own centre of 118, and not on top of the circle.
  assert.deepEqual(of('Application').map((entry) => entry.x), [130]);
  for (const entry of of('Application')) assert.ok(entry.y > 136, `${entry.y} overlaps the event`);
  // No label bounds at all: an event is too small to hold its name, so it goes underneath.
  for (const entry of of('Timeout')) assert.ok(entry.y > 136, `${entry.y} overlaps the event`);
  // An activity is large enough, and its name stays inside it.
  for (const entry of of('credit')) assert.ok(entry.y > 80 && entry.y < 160, `${entry.y} left the box`);
  // An unnamed element is still drawn; it just has no text to place.
  assert.match(svg, /data-id="anon"/);
  assert.equal(texts.length, 4, 'two lines for the placed label, one each for the named rest');
});

test('the drawing takes its palette from the page, and falls back to a light one on its own', async () => {
  const svg = render(await claim());

  assert.match(svg, /var\(--treadle-ground, #F1F3F2\)/, 'the ground is themeable');
  assert.match(svg, /var\(--treadle-ink, #14191B\)/, 'so is the ink');
  assert.doesNotMatch(svg, /"#14191B"/, 'no colour is hard-coded past the fallback');
});

const POOLS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="C">
    <bpmn:participant id="Us" name="Our side" processRef="P" />
    <bpmn:participant id="Them" name="Supplier" />
    <bpmn:messageFlow id="Ask" name="order" sourceRef="Work" targetRef="Them" />
  </bpmn:collaboration>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:laneSet id="LS">
      <bpmn:lane id="Sales" name="Sales"><bpmn:flowNodeRef>Work</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="Ops" name="Ops" />
    </bpmn:laneSet>
    <bpmn:task id="Work" name="Do it" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="C">
    <bpmndi:BPMNShape id="S_Us" bpmnElement="Us" isHorizontal="true"><dc:Bounds x="100" y="60" width="400" height="200"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Sales" bpmnElement="Sales" isHorizontal="true"><dc:Bounds x="130" y="60" width="370" height="100"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Ops" bpmnElement="Ops" isHorizontal="true"><dc:Bounds x="130" y="160" width="370" height="100"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Work" bpmnElement="Work"><dc:Bounds x="200" y="70" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Them" bpmnElement="Them" isHorizontal="true"><dc:Bounds x="100" y="320" width="400" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E_Ask" bpmnElement="Ask"><di:waypoint x="250" y="150"/><di:waypoint x="250" y="320"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test('a pool is a band and a body, drawn behind what it contains', async () => {
  const svg = render((await parse(POOLS)).definitions);

  assert.match(svg, /data-kind="pool"[^>]*/, 'the pool is drawn and identified');
  assert.equal((svg.match(/data-kind="lane"/g) ?? []).length, 2, 'both lanes are drawn');
  // A container drawn after its contents would paint over them.
  assert.ok(svg.indexOf('data-id="Us"') < svg.indexOf('data-id="Work"'), 'pool behind the task');
  assert.ok(svg.indexOf('data-id="Us"') < svg.indexOf('data-id="Sales"'), 'pool behind its lanes');
  // The name goes in the band, turned on its side, which is what makes a pool read as a pool.
  assert.match(svg, /rotate\(-90[^)]*\)"[^>]*>Our side</);
  assert.match(svg, /rotate\(-90[^)]*\)"[^>]*>Sales</);
  // A black-box pool has no process behind it and still has to be drawn.
  assert.match(svg, /data-id="Them"/);
});

test('a message flow is dashed and open-headed, and a sequence flow is neither', async () => {
  const svg = render((await parse(POOLS)).definitions);
  const message = svg.match(/<[^>]*data-id="Ask"[^>]*>/)[0];

  assert.match(message, /stroke-dasharray/, 'a message flow is dashed');
  assert.match(message, /data-kind="message"/);
  assert.match(message, /marker-end="url\(#message-end\)"/);
  assert.match(message, /marker-start="url\(#message-start\)"/);
});

const NOTATION = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Begin" name="Order in"><bpmn:messageEventDefinition id="md"/></bpmn:startEvent>
    <bpmn:userTask id="Judge" name="Judge it" />
    <bpmn:serviceTask id="Call" name="Call out" />
    <bpmn:inclusiveGateway id="Some" name="Which?" />
    <bpmn:intermediateThrowEvent id="Tell" name="Announce"><bpmn:signalEventDefinition id="sd"/></bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Wait" name="Hold"><bpmn:timerEventDefinition id="td"/></bpmn:intermediateCatchEvent>
    <bpmn:boundaryEvent id="Late" name="Too late" attachedToRef="Judge" cancelActivity="false">
      <bpmn:timerEventDefinition id="td2"/>
    </bpmn:boundaryEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="P">
    <bpmndi:BPMNShape id="S1" bpmnElement="Begin"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S2" bpmnElement="Judge"><dc:Bounds x="180" y="78" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S3" bpmnElement="Call"><dc:Bounds x="320" y="78" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S4" bpmnElement="Some"><dc:Bounds x="460" y="93" width="50" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S5" bpmnElement="Tell"><dc:Bounds x="550" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S6" bpmnElement="Wait"><dc:Bounds x="620" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S7" bpmnElement="Late"><dc:Bounds x="212" y="140" width="36" height="36"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test('each element carries the mark BPMN gives its type, and the mark says what it is', async () => {
  const svg = render((await parse(NOTATION)).definitions);
  const glyph = (id) =>
    svg.match(new RegExp(`data-id="${id}"[\\s\\S]*?data-glyph="([a-z_]+)"`))?.[1];

  assert.equal(glyph('Judge'), 'user', 'a user task wears the person');
  assert.equal(glyph('Call'), 'service', 'a service task wears the gear');
  assert.equal(glyph('Some'), 'or', 'an inclusive gateway wears its circle');
  assert.equal(glyph('Begin'), 'message', 'an event wears its kind, not its block');
  assert.equal(glyph('Wait'), 'timer');
  assert.equal(glyph('Tell'), 'signal');

  // Throwing an event fills its mark; catching one leaves it open. That is the whole difference
  // between "this happened" and "this is being waited for".
  const mark = (id) => svg.match(new RegExp(`data-id="${id}"[\\s\\S]*?(<g data-glyph="[^"]+"[^>]*>)`))[1];
  assert.match(mark('Tell'), /fill="var\(--treadle-ink[^"]*\)"/, 'a throw is solid');
  assert.match(mark('Wait'), /fill="none"/, 'a catch is open');

  // A non-interrupting boundary event is drawn dashed — it does not kill its host.
  assert.match(svg.match(/<circle data-id="Late"[^>]*>/)[0], /stroke-dasharray/);
});

test('the drawing states what an agent would otherwise have to re-read the file for', async () => {
  const svg = render((await parse(NOTATION)).definitions);
  const attributes = (id) => svg.match(new RegExp(`<[a-z]+ data-id="${id}"[^>]*>`))[0];

  assert.match(attributes('Judge'), /data-in="P"/, 'what contains it');
  assert.match(attributes('Late'), /data-on="Judge"/, 'what it is attached to');
  assert.match(attributes('Begin'), /data-event="message"/, 'the kind it carries');
  assert.match(attributes('Judge'), /data-kind="user"/, 'the block it is');
});

test('an artifact is drawn in its own notation, and its association is dotted', async () => {
  const { document, original } = await normalizedFixture('miwg/B.1.0.bpmn');
  const svg = render(document.definitions);
  const ir = project(document.definitions);

  // Everything the DI places is drawn, and nothing else is: a data input that exists only in an
  // activity's ioSpecification has no coordinates, and inventing them is what ADR-003 forbids.
  const placed = (id) => original.includes(`bpmnElement="${id}"`);
  const artifacts = [...(ir.data ?? []), ...(ir.notes ?? []), ...(ir.groups ?? [])];
  assert.ok(artifacts.some((item) => !placed(item.id)), 'the fixture has an unplaced artifact');
  for (const item of artifacts) {
    assert.equal(svg.includes(`data-id="${item.id}"`), placed(item.id), item.id);
  }

  // A data object is a page with a folded corner; a store is a cylinder; a group is a dashed box.
  assert.match(svg, /data-kind="object"/);
  assert.match(svg, /data-kind="store"/);
  assert.match(svg, /data-kind="group"[^>]*stroke-dasharray/);
  // An association carries no flow, so it is dotted and unheaded — the difference between "this is
  // about that" and "this then that".
  const link = ir.links.find((entry) => svg.includes(`data-id="${entry.id}"`));
  assert.match(svg.match(new RegExp(`<[^>]*data-id="${link.id}"[^>]*>`))[0], /stroke-dasharray="1 3"/);
});

test('a default flow is ticked and a conditional flow starts at a diamond', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:exclusiveGateway id="Pick" default="Otherwise" />
    <bpmn:task id="A" /><bpmn:task id="B" />
    <bpmn:sequenceFlow id="Otherwise" sourceRef="Pick" targetRef="A" />
    <bpmn:sequenceFlow id="WhenBig" sourceRef="Pick" targetRef="B">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">big</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="P">
    <bpmndi:BPMNShape id="S1" bpmnElement="Pick"><dc:Bounds x="100" y="100" width="50" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S2" bpmnElement="A"><dc:Bounds x="220" y="40" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S3" bpmnElement="B"><dc:Bounds x="220" y="160" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E1" bpmnElement="Otherwise"><di:waypoint x="150" y="125"/><di:waypoint x="220" y="80"/></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="E2" bpmnElement="WhenBig"><di:waypoint x="150" y="125"/><di:waypoint x="220" y="200"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const svg = render((await parse(xml)).definitions);

  assert.match(svg, /data-mark="default"/, 'the branch taken when nothing else matches');
  assert.match(svg, /data-mark="conditional"/, 'the branch with a condition on it');
  // Only the two that earned a mark get one.
  assert.equal((svg.match(/data-mark=/g) ?? []).length, 2);
});

test('the notation holds for the shapes a file may leave nameless, vertical, or degenerate', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="C"><bpmn:participant id="Down" name="Downwards" processRef="P" /></bpmn:collaboration>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:laneSet id="LS"><bpmn:lane id="Nameless" /></bpmn:laneSet>
    <bpmn:dataObjectReference id="Anon" dataObjectRef="DO" />
    <bpmn:dataObject id="DO" />
    <bpmn:dataStoreReference id="Silent" />
    <bpmn:textAnnotation id="Empty" />
    <bpmn:exclusiveGateway id="Pick" default="Plain" />
    <bpmn:task id="A" /><bpmn:task id="B" />
    <bpmn:ioSpecification id="IO">
      <bpmn:dataInput id="In" /><bpmn:dataOutput id="Out" />
    </bpmn:ioSpecification>
    <bpmn:sequenceFlow id="Plain" sourceRef="Pick" targetRef="A" />
    <bpmn:sequenceFlow id="Guarded" sourceRef="Pick" targetRef="B">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">yes</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="C">
    <bpmndi:BPMNShape id="S_Down" bpmnElement="Down" isHorizontal="false"><dc:Bounds x="60" y="40" width="300" height="400"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Nameless" bpmnElement="Nameless" isHorizontal="false"><dc:Bounds x="60" y="70" width="150" height="370"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Anon" bpmnElement="Anon"><dc:Bounds x="400" y="60" width="36" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Silent" bpmnElement="Silent"><dc:Bounds x="460" y="60" width="50" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Empty" bpmnElement="Empty"><dc:Bounds x="540" y="60" width="100" height="40"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_In" bpmnElement="In"><dc:Bounds x="400" y="140" width="36" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Out" bpmnElement="Out"><dc:Bounds x="460" y="140" width="36" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_Pick" bpmnElement="Pick"><dc:Bounds x="100" y="200" width="50" height="50"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_A" bpmnElement="A"><dc:Bounds x="220" y="140" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="S_B" bpmnElement="B"><dc:Bounds x="220" y="260" width="100" height="80"/></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="E_Plain" bpmnElement="Plain"><di:waypoint x="150" y="225"/><di:waypoint x="220" y="180"/></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="E_Guarded" bpmnElement="Guarded"><di:waypoint x="150" y="225"/><di:waypoint x="150" y="225"/><di:waypoint x="220" y="300"/></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const svg = render((await parse(xml)).definitions);

  // A vertical pool hangs its band across the top and does not turn its name on its side.
  const band = svg.match(/<path d="M60,70 H360"[^>]*>/);
  assert.ok(band, 'the vertical pool divides across the top');
  assert.doesNotMatch(svg, /rotate\(-90/, 'a vertical band reads straight');
  assert.match(svg, />Downwards</, 'and still carries its name');
  assert.match(svg, /data-id="Nameless"/, 'a lane with no name is still a lane');

  // Nameless artifacts are drawn without a label rather than with an empty one.
  assert.match(svg, /data-kind="object"/);
  assert.match(svg, /data-kind="store"/);
  assert.match(svg, /data-kind="note"/);
  assert.equal((svg.match(/><\/text>/g) ?? []).length, 0, 'no empty labels');

  // A data input points in, a data output points out, and the arrow says which.
  assert.match(svg, /data-kind="input"/);
  assert.match(svg, /data-kind="output"/);

  // A degenerate first segment cannot produce NaN coordinates.
  assert.doesNotMatch(svg, /NaN/);
  assert.match(svg, /data-mark="conditional"/);
  assert.match(svg, /data-mark="default"/);
});

test('every piece drawn for an element carries that element id, labels included', async () => {
  const svg = render((await parse(POOLS)).definitions);
  const owned = (id) => (svg.match(new RegExp(`data-id="${id}"`, 'g')) ?? []).length;

  // A label is a sibling of the shape it names, not a child, so a hit test that walks up from the
  // text finds the drawing root unless the text says whose it is.
  assert.match(svg, /<text[^>]*data-id="Work"[^>]*>Do it</, 'the task name belongs to the task');
  assert.match(svg, /<text[^>]*data-id="Us"[^>]*>Our side</, 'the band name belongs to the pool');
  assert.ok(owned('Work') >= 2, 'the shape and its label');
  assert.ok(owned('Sales') >= 2);
});
