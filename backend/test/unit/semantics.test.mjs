import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintClean, semantics, xsdValid } from '../../core/gates.mjs';
import { readFixture } from '../support/fixture.mjs';

const bpmn = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">${body}  </bpmn:process>
  <bpmndi:BPMNDiagram id="Di"><bpmndi:BPMNPlane id="Pl" bpmnElement="P"/></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const race = (targetKind) => bpmn(`
    <bpmn:startEvent id="s" name="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:eventBasedGateway id="g" name="g"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing><bpmn:outgoing>f3</bpmn:outgoing></bpmn:eventBasedGateway>
    ${targetKind}
    <bpmn:intermediateCatchEvent id="c" name="c"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f5</bpmn:outgoing><bpmn:timerEventDefinition/></bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="e" name="e"><bpmn:incoming>f4</bpmn:incoming><bpmn:incoming>f5</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g"/>
    <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="x"/>
    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="c"/>
    <bpmn:sequenceFlow id="f4" sourceRef="x" targetRef="e"/>
    <bpmn:sequenceFlow id="f5" sourceRef="c" targetRef="e"/>
`);

const TASK = '<bpmn:task id="x" name="x"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:task>';
const RECEIVE = '<bpmn:receiveTask id="x" name="x"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:receiveTask>';
const CATCH =
  '<bpmn:intermediateCatchEvent id="x" name="x"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing><bpmn:messageEventDefinition/></bpmn:intermediateCatchEvent>';

test('a valid document has nothing to say', async () => {
  assert.deepEqual((await semantics(await readFixture())).findings, []);
});

// The only rule that survived the non-overlap check: bpmnlint catches an unreachable node
// (no-disconnected) and a node that reaches no end (correctness), so neither belongs here.
test('an event gateway whose target cannot wait is caught by nothing else', async () => {
  const xml = race(TASK);

  assert.equal((await xsdValid(xml)).ok, true, 'must be XSD-valid');
  for (const preset of ['bpmnlint:correctness', 'bpmnlint:recommended']) {
    assert.equal(
      (await lintClean(xml, { hasDI: false, config: { extends: preset } })).ok,
      true,
      preset,
    );
  }

  const result = await semantics(xml);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [
    { rule: 'event-gateway-target-cannot-wait', id: 'g', target: 'x', type: 'task' },
  ]);
});

test('a receive task and a catch event are both things that can wait', async () => {
  for (const [what, target] of [['receive task', RECEIVE], ['catch event', CATCH]]) {
    assert.deepEqual((await semantics(race(target))).findings, [], what);
  }
});

test('the whole corpus is clean under this rule', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../../../bench/corpus/miwg/', import.meta.url).pathname;

  for (const name of (await readdir(root)).filter((file) => file.endsWith('.bpmn'))) {
    const result = await semantics(await readFile(`${root}${name}`, 'utf8'));
    assert.deepEqual(result.findings, [], name);
  }
});

test('an event gateway with no way out is not this rule to report', async () => {
  const orphan = bpmn(`
    <bpmn:startEvent id="s" name="s"/>
    <bpmn:eventBasedGateway id="g" name="g"/>
    <bpmn:endEvent id="e" name="e"/>
`);

  // A gateway that leads nowhere is caught by bpmnlint, not here. This gate says only what the
  // targets of a race must be, and a race with no runners has no target to judge.
  assert.deepEqual((await semantics(orphan)).findings, []);
  assert.equal(
    (await lintClean(orphan, { hasDI: false, config: { extends: 'bpmnlint:recommended' } })).ok,
    false,
  );
});
