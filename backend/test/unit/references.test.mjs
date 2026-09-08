import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintClean, references, xsdValid } from '../../core/gates.mjs';
import { readFixture } from '../support/fixture.mjs';

const bpmn = (body, extra = '', di = '') => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    id="D1" targetNamespace="http://bpmn.io/schema/bpmn">
${extra}  <bpmn:process id="P" isExecutable="true">
${body}  </bpmn:process>
  <bpmndi:BPMNDiagram id="D"><bpmndi:BPMNPlane id="PL" bpmnElement="P">${di}
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const CHAIN = `    <bpmn:startEvent id="s" name="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="t" name="t"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="e" name="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
`;
const shape = (id) => `\n    <bpmndi:BPMNShape id="S_${id}" bpmnElement="${id}"><dc:Bounds x="10" y="10" width="36" height="36"/></bpmndi:BPMNShape>`;
const CHAIN_DI = shape('s') + shape('t') + shape('e');

// Every case here was measured against both other gates first: each document below is XSD-valid
// and passes bpmnlint:correctness. A rule that either of them already catches does not belong in
// this gate — a duplicate id, for one, is caught by the XSD's ID type and is deliberately absent.
const BROKEN = {
  'unresolved-reference': [
    'a flow whose target does not exist',
    bpmn(CHAIN.replace('targetRef="e"', 'targetRef="ghost"'), '', CHAIN_DI),
    'f2',
  ],
  'unresolved-reference/boundary': [
    'a boundary event attached to nothing',
    bpmn(
      `${CHAIN}    <bpmn:boundaryEvent id="b" name="b" attachedToRef="ghost"><bpmn:timerEventDefinition/></bpmn:boundaryEvent>\n`,
      '',
      CHAIN_DI + shape('b'),
    ),
    'b',
  ],
  'unresolved-reference/di': [
    'a shape drawn for an element that is not there',
    bpmn(CHAIN, '', CHAIN_DI + shape('ghost')),
    'S_ghost',
  ],
  'flow-crosses-container': [
    'a sequence flow reaching into a subprocess',
    bpmn(
      `${CHAIN}    <bpmn:subProcess id="sub" name="sub"><bpmn:task id="inner" name="inner"/></bpmn:subProcess>
    <bpmn:sequenceFlow id="cross" sourceRef="t" targetRef="inner"/>\n`,
      '',
      CHAIN_DI + shape('sub') + shape('inner'),
    ),
    'cross',
  ],
  'boundary-outside-host': [
    'a boundary event whose host lives in another container',
    bpmn(
      `${CHAIN}    <bpmn:subProcess id="sub" name="sub"><bpmn:task id="inner" name="inner"/>
      <bpmn:boundaryEvent id="b2" name="b2" attachedToRef="t"><bpmn:timerEventDefinition/></bpmn:boundaryEvent></bpmn:subProcess>\n`,
      '',
      CHAIN_DI + shape('sub') + shape('inner') + shape('b2'),
    ),
    'b2',
  ],
  'lane-outside-process': [
    'a lane claiming a node from another process',
    bpmn(
      `    <bpmn:laneSet id="ls"><bpmn:lane id="L" name="L"><bpmn:flowNodeRef>other</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet>\n${CHAIN}`,
      `  <bpmn:process id="P2"><bpmn:task id="other" name="other"/></bpmn:process>\n`,
      CHAIN_DI + shape('L') + shape('other'),
    ),
    'L',
  ],
  'default-not-outgoing': [
    'a gateway whose default flow does not leave it',
    bpmn(
      `    <bpmn:startEvent id="s" name="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:exclusiveGateway id="g" name="g" default="f1"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:endEvent id="e" name="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g"/>
    <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="e"/>\n`,
      '',
      shape('s') + shape('g') + shape('e'),
    ),
    'g',
  ],
};

test('a valid document passes the reference gate', async () => {
  const result = await references(await readFixture());
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

for (const [key, [what, xml, culprit]] of Object.entries(BROKEN)) {
  const rule = key.split('/')[0];

  test(`the reference gate catches ${what}`, async () => {
    // The proof of non-overlap: neither existing gate sees this.
    assert.equal((await xsdValid(xml)).ok, true, 'must be XSD-valid');
    assert.equal(
      (await lintClean(xml, { config: { extends: 'bpmnlint:correctness' } })).ok,
      true,
      'must pass bpmnlint:correctness',
    );

    const result = await references(xml);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.findings.map((finding) => finding.rule),
      [rule],
    );
    assert.equal(result.findings[0].id, culprit);
    assert.doesNotMatch(JSON.stringify(result.findings), /bpmn:|<|name="/, 'must not leak content');
  });
}
