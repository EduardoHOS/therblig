import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, seconds, simulate } from '../../core/index.mjs';
import { readFixture } from '../support/fixture.mjs';

const claim = async () => (await parse(await readFixture('handmade/parallel-join.bpmn'))).definitions;

// The whole reason this is discrete-event and not a running clock. A 4-hour branch and a 9-hour
// branch that run at the same time take 9 hours, never 13.
test('a parallel join takes the longer branch, not the sum of both', async () => {
  const result = await simulate(await claim(), { runs: 50, seed: 1, when: { '=covered': true } });

  // 9h to the join, then 1h to pay.
  assert.equal(result.p50, 10 * 3600);
  assert.equal(result.p90, 10 * 3600);
  assert.equal(result.deadlocks, 0);
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.synthetic, false);
});

test('the exclusive gateway takes the default when its condition does not hold', async () => {
  const covered = await simulate(await claim(), { runs: 20, seed: 1, when: { '=covered': true } });
  const not = await simulate(await claim(), { runs: 20, seed: 1, when: { '=covered': false } });

  assert.equal(covered.visits.Pay, 20);
  assert.equal(covered.visits.Reject, undefined);
  assert.equal(not.visits.Reject, 20);
  assert.equal(not.p50, 11 * 3600, '9h to the join, then 2h to reject');
});

test('a probability is honoured, and the same seed gives the same answer twice', async () => {
  const once = await simulate(await claim(), { runs: 200, seed: 7, when: { '=covered': 0.25 } });
  const again = await simulate(await claim(), { runs: 200, seed: 7, when: { '=covered': 0.25 } });

  assert.deepEqual(once, again, 'seeded, so a test can assert an exact number');
  assert.ok(once.visits.Pay > 20 && once.visits.Pay < 80, `paid ${once.visits.Pay} of 200`);
  assert.equal(once.visits.Pay + once.visits.Reject, 200);
});

test('a file with no annotated durations says its numbers are made up', async () => {
  const document = await parse(await readFixture());
  const result = await simulate(document.definitions, { runs: 10, seed: 1 });

  assert.equal(result.synthetic, true, 'nothing in this file carries a duration');
  assert.ok(result.p50 > 0);
});

// Refusing by name is the point: a number that quietly guessed at an OR-join would be worse than
// no number, and the design says so.
test('an inclusive join is refused by name instead of guessed at', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:inclusiveGateway id="or_split"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing><bpmn:outgoing>f3</bpmn:outgoing></bpmn:inclusiveGateway>
    <bpmn:task id="a"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:task>
    <bpmn:task id="b"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f5</bpmn:outgoing></bpmn:task>
    <bpmn:inclusiveGateway id="or_join"><bpmn:incoming>f4</bpmn:incoming><bpmn:incoming>f5</bpmn:incoming><bpmn:outgoing>f6</bpmn:outgoing></bpmn:inclusiveGateway>
    <bpmn:endEvent id="e"><bpmn:incoming>f6</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="or_split"/>
    <bpmn:sequenceFlow id="f2" sourceRef="or_split" targetRef="a"/>
    <bpmn:sequenceFlow id="f3" sourceRef="or_split" targetRef="b"/>
    <bpmn:sequenceFlow id="f4" sourceRef="a" targetRef="or_join"/>
    <bpmn:sequenceFlow id="f5" sourceRef="b" targetRef="or_join"/>
    <bpmn:sequenceFlow id="f6" sourceRef="or_join" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

  const result = await simulate((await parse(xml)).definitions, { runs: 5, seed: 1 });

  assert.deepEqual(result.unsupported, ['or_join']);
  assert.equal(result.p50, null, 'no cycle time is reported for a model it cannot run');
});

test('a gateway with nowhere to go halts and is reported as a deadlock', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:exclusiveGateway id="g"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:endEvent id="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g"/>
    <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="e">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">=never</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;

  const result = await simulate((await parse(xml)).definitions, { runs: 4, seed: 1, when: { '=never': false } });

  assert.equal(result.deadlocks, 4);
  assert.equal(result.p50, null);
});

test('every MIWG model is either simulated or refused by name, and never guessed at', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../../../bench/corpus/miwg/', import.meta.url);
  const summary = { ran: 0, refused: 0 };

  for (const name of (await readdir(root)).filter((file) => file.endsWith('.bpmn'))) {
    const document = await parse(await readFixture(`miwg/${name}`));
    const result = await simulate(document.definitions, { runs: 3, seed: 1 });
    if (result.unsupported.length) summary.refused++;
    else summary.ran++;
    // A refusal names what it could not run; it never produces a number anyway.
    if (result.unsupported.length) assert.equal(result.p50, null, name);
  }

  assert.equal(summary.ran + summary.refused, 21, 'every MIWG model was accounted for');
  assert.ok(summary.ran > 0, 'at least some of the corpus is simulable');
});

test('a rework loop needs a scenario, and reports what it needed when it has none', async () => {
  const document = await parse(await readFixture('miwg/C.7.0.bpmn'));

  // C.7.0 sends an unapproved advertisement back to be approved again — an ordinary rework loop,
  // and one whose exits carry labels rather than conditions.
  const bare = simulate(document.definitions, { runs: 5, seed: 3 });
  assert.equal(bare.p50, null);
  assert.equal(bare.undecided.length, 1, 'it names the gateway it could not decide');

  const scenario = simulate(document.definitions, { runs: 400, seed: 3, when: { Yes: 0.8, No: 0.2 } });
  assert.deepEqual(scenario.undecided, []);
  assert.equal(scenario.unbounded, 0);
  assert.equal(scenario.p50, 5 * 3600);
  assert.equal(scenario.p90, 7 * 3600, 'the rework shows up in the tail, which is the point');
});

test('a loop the scenario never exits is reported, not hung', async () => {
  const document = await parse(await readFixture('miwg/C.7.0.bpmn'));

  const forever = simulate(document.definitions, { runs: 3, seed: 1, when: { No: 1, Yes: 0 } });

  assert.equal(forever.unbounded, 3);
  assert.equal(forever.p50, null);
});

test('a scenario that names one path leaves the rest to share what is left', async () => {
  const document = await parse(await readFixture('handmade/parallel-join.bpmn'));

  // '=covered' at 0.25 means the other exit takes the remaining 0.75; it is not an independent
  // coin that can leave the gateway undecided.
  const result = simulate(document.definitions, { runs: 400, seed: 11, when: { '=covered': 0.25 } });

  assert.deepEqual(result.undecided, []);
  assert.equal(result.visits.Pay + result.visits.Reject, 400);
  assert.ok(result.visits.Pay > 60 && result.visits.Pay < 140, `paid ${result.visits.Pay} of 400`);
});

// The join waits, and that is the whole point — so a join that waits for a branch which never
// runs has to be reported rather than silently dropped or silently completed.
test('a parallel join whose other branch never runs is a deadlock, not a shrug', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="only" name="only"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:task>
    <bpmn:parallelGateway id="join"><bpmn:incoming>f2</bpmn:incoming><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:task id="orphan" name="orphan"><bpmn:outgoing>f3</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="e"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="only"/>
    <bpmn:sequenceFlow id="f2" sourceRef="only" targetRef="join"/>
    <bpmn:sequenceFlow id="f3" sourceRef="orphan" targetRef="join"/>
    <bpmn:sequenceFlow id="f4" sourceRef="join" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

  const result = simulate((await parse(xml)).definitions, { runs: 4, seed: 1 });

  assert.equal(result.deadlocks, 4);
  assert.equal(result.p50, null);
  assert.equal(result.visits.only, 4, 'the live branch did run');
  assert.equal(result.visits.join, undefined, 'the join never fired');
});

test('a duration is read only when it is one', () => {
  assert.equal(seconds('PT4H'), 4 * 3600);
  assert.equal(seconds('P1DT2H30M15S'), 86400 + 2 * 3600 + 30 * 60 + 15);
  assert.equal(seconds('P0D'), 0, 'zero is a duration; nothing at all is not');
  for (const nonsense of [undefined, '', 'P', 'PT', '4h', 'three days']) {
    assert.equal(seconds(nonsense), null, JSON.stringify(nonsense));
  }
});

test('a terminate end event stops the run where it is', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:parallelGateway id="split"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing><bpmn:outgoing>f3</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:endEvent id="stop"><bpmn:incoming>f2</bpmn:incoming><bpmn:terminateEventDefinition/></bpmn:endEvent>
    <bpmn:task id="never" name="never"><bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="e"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="split"/>
    <bpmn:sequenceFlow id="f2" sourceRef="split" targetRef="stop"/>
    <bpmn:sequenceFlow id="f3" sourceRef="split" targetRef="never"/>
    <bpmn:sequenceFlow id="f4" sourceRef="never" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

  const result = simulate((await parse(xml)).definitions, { runs: 3, seed: 1 });

  assert.equal(result.visits.stop, 3);
  assert.equal(result.visits.never, undefined, 'the other branch never got its turn');
  assert.equal(result.p50, 0, 'terminate fires before any work is done');
});

test('an empty process has nothing to run and says so without dividing by zero', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true" />
</bpmn:definitions>`;

  const result = simulate((await parse(xml)).definitions, { runs: 3, seed: 1 });

  assert.equal(result.p50, null);
  assert.equal(result.p90, null);
  assert.equal(result.deadlocks, 3, 'a run that reaches no end is a run that went nowhere');
});

test('a gateway with no way out at all, and a flow that points at nothing', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:exclusiveGateway id="dead"><bpmn:incoming>f1</bpmn:incoming></bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="dead"/>
  </bpmn:process>
</bpmn:definitions>`;

  const gateway = simulate((await parse(xml)).definitions, { runs: 2, seed: 1 });
  assert.equal(gateway.deadlocks, 2);
  assert.deepEqual(gateway.undecided, [], 'nowhere to go is not a decision it failed to make');

  // A dangling targetRef is dropped by the parser, so the token has nowhere to arrive. The
  // reference gate is what reports this; the machine only has to not crash on it.
  const dangling = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="ghost"/>
  </bpmn:process>
</bpmn:definitions>`;

  const broken = simulate((await parse(dangling)).definitions, { runs: 2, seed: 1 });
  assert.equal(broken.deadlocks, 2);
  assert.equal(broken.p50, null);
});
