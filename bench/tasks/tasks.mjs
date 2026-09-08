// The twenty edit tasks. Each prompt is written the way someone who owns that process would say
// it out loud: no element ids, no BPMN vocabulary, and slight ambiguity where a real request has
// it. The assertion is mechanical and runs against the projected IR of whatever an arm produced.
//
// PROVENANCE — read this before quoting any number these produce. The brief in TASKS.md asks for
// prompts written by someone other than the author of the API under test, because an author picks
// tasks their own API handles well and the bake-off then measures nothing. These were written by
// that author, at the maintainer's explicit direction. Three things were done to blunt the bias,
// and none of them removes it:
//
//   1. The category and stratum grid was fixed first, from the brief, before any prompt was
//      written — so coverage is not a function of what the ops do well.
//   2. Prompts were written against each file's real content, not against the op catalogue.
//   3. Tasks known to be hard or impossible for the structured arm were kept deliberately:
//      T20 lands on pools that share no collaboration, which `connect` refuses outright.
//
// Any finding built on these must say who wrote them. An independent author replacing this file
// is the only thing that removes the caveat.

const find = (ir, pattern) => (ir.nodes ?? []).filter((node) => pattern.test((node.name ?? '').replace(/\s+/g, ' ')));
const flows = (ir) => ir.flows ?? [];
const idsOf = (ir) => new Set([...(ir.nodes ?? []), ...flows(ir)].map((element) => element.id));

const added = (ir, before) => {
  const known = idsOf(before);
  return (ir.nodes ?? []).filter((node) => !known.has(node.id));
};
const gone = (ir, before) => {
  const now = idsOf(ir);
  return (before.nodes ?? []).filter((node) => !now.has(node.id));
};

// x sits on the path from a to b: a → x and x → b, whatever ids the arm minted for the flows.
const spliced = (ir, a, x, b) =>
  flows(ir).some((flow) => flow.from === a && flow.to === x) &&
  flows(ir).some((flow) => flow.from === x && flow.to === b);

const reachable = (ir, from, to) => {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.pop();
    for (const flow of flows(ir)) {
      if (flow.from !== id || seen.has(flow.to)) continue;
      if (flow.to === to) return true;
      seen.add(flow.to);
      queue.push(flow.to);
    }
  }
  return false;
};

// Exactly one match, or nothing: an assertion that silently picks the first of several is not
// an assertion. A null here fails the check with a TypeError, which the scorer reports.
const one = (list) => (list.length === 1 ? list[0] : null);
const laneOf = (ir, node) => (ir.lanes ?? []).find((lane) => lane.id === node?.lane)?.name?.trim();

export const tasks = [
  // ---- insert a step in a sequence ----
  {
    id: 'T01',
    file: 'miwg/C.9.0.bpmn',
    category: 'insert',
    prompt:
      'After the credit score is fetched, add a step where an analyst reviews the score before the application is checked automatically.',
    check(ir, before) {
      const fresh = added(ir, before);
      if (fresh.length !== 1) return [`expected exactly one new node, got ${fresh.length}`];
      const score = one(find(before, /credit score/i));
      const auto = one(find(before, /automatically/i));
      if (!spliced(ir, score.id, fresh[0].id, auto.id)) {
        return ['the new step is not between fetching the score and the automatic check'];
      }
      if (!/review|analy|check/i.test(fresh[0].name ?? '')) return ['the new step is not named for what it does'];
      return [];
    },
  },
  {
    id: 'T02',
    file: 'miwg/C.5.0.bpmn',
    category: 'insert',
    prompt:
      'Before the risk assessment gets documented, we want a second person to double-check it. Add that step.',
    check(ir, before) {
      const fresh = added(ir, before);
      if (fresh.length !== 1) return [`expected exactly one new node, got ${fresh.length}`];
      const document = one(find(before, /document risk assessment/i));
      if (!flows(ir).some((flow) => flow.from === fresh[0].id && flow.to === document.id)) {
        return ['the new step does not lead into documenting the risk assessment'];
      }
      return [];
    },
  },

  // ---- delete a step and heal the chain ----
  {
    id: 'T03',
    file: 'miwg/C.1.0.bpmn',
    category: 'delete',
    prompt:
      'We stopped keeping paper, so the step that archives the original invoice should go away. The flow around it has to still work.',
    check(ir, before) {
      const target = one(find(before, /archive original/i));
      if ((ir.nodes ?? []).some((node) => node.id === target.id)) return ['the step is still there'];
      const entry = flows(before).find((flow) => flow.to === target.id);
      const exit = flows(before).find((flow) => flow.from === target.id);
      if (!reachable(ir, entry.from, exit.to)) return ['the chain was not healed across the gap'];
      return [];
    },
  },
  {
    id: 'T04',
    file: 'miwg/C.9.0.bpmn',
    category: 'delete',
    prompt: 'Drop the step that sends the rejection — rejecting the application is enough on its own.',
    check(ir, before) {
      const target = one(find(before, /send rejection/i));
      if ((ir.nodes ?? []).some((node) => node.id === target.id)) return ['the step is still there'];
      const entry = flows(before).find((flow) => flow.to === target.id);
      const exit = flows(before).find((flow) => flow.from === target.id);
      if (!reachable(ir, entry.from, exit.to)) return ['the chain was not healed across the gap'];
      if (gone(ir, before).length !== 1) return ['something other than that step was removed'];
      return [];
    },
  },

  // ---- add a boundary event ----
  {
    id: 'T05',
    file: 'miwg/C.9.2.bpmn',
    category: 'boundary',
    prompt:
      'The fraud check should give up after two days and go to the step that accelerates the decision.',
    check(ir, before) {
      const host = one(find(before, /check for fraud/i));
      const target = one(find(before, /accelerate/i));
      const boundary = added(ir, before).find((node) => node.type === 'boundary');
      if (!boundary) return ['no boundary event was added'];
      if (boundary.on !== host.id) return ['the boundary is not attached to the fraud check'];
      if (boundary.event !== 'timer') return [`the boundary is a ${boundary.event ?? 'plain'} event, not a timer`];
      if (!flows(ir).some((flow) => flow.from === boundary.id && flow.to === target.id)) {
        return ['the boundary does not lead to accelerating the decision'];
      }
      return [];
    },
  },
  {
    id: 'T06',
    file: 'miwg/C.8.1.bpmn',
    category: 'boundary',
    prompt:
      'If fetching the vacation information fails, do not leave it hanging — send the employee the refusal notice.',
    check(ir, before) {
      const host = one(find(before, /fetch vacation/i));
      const boundary = added(ir, before).find((node) => node.type === 'boundary');
      if (!boundary) return ['no boundary event was added'];
      if (boundary.on !== host.id) return ['the boundary is not attached to fetching the information'];
      if (boundary.event !== 'error') return [`the boundary is a ${boundary.event ?? 'plain'} event, not an error`];
      const exit = flows(ir).find((flow) => flow.from === boundary.id);
      const target = (ir.nodes ?? []).find((node) => node.id === exit?.to);
      if (!/refusal/i.test(target?.name ?? '')) return ['the boundary does not lead to a refusal notice'];
      return [];
    },
  },

  // ---- split a path on a condition ----
  {
    id: 'T07',
    file: 'miwg/C.9.1.bpmn',
    category: 'split',
    prompt:
      'We only want to send the reminder email when the customer has missed the deadline. Otherwise the process should carry straight on.',
    check(ir, before) {
      const reminder = one(find(before, /reminder/i));
      const gateway = added(ir, before).find((node) => ['xor', 'or'].includes(node.type));
      if (!gateway) return ['no decision gateway was added'];
      if (!reachable(ir, gateway.id, reminder.id)) return ['the reminder is not behind the new decision'];
      const exits = flows(ir).filter((flow) => flow.from === gateway.id);
      if (exits.length < 2) return ['the decision has only one way out'];
      if (!exits.some((flow) => flow.if) && !gateway.default) return ['neither exit is conditioned or default'];
      return [];
    },
  },
  {
    id: 'T08',
    file: 'miwg/C.3.0.bpmn',
    category: 'split',
    prompt:
      'After we analyse the customer request, check whether the appliance is still under warranty before we pick a service level.',
    check(ir, before) {
      const analyse = one(find(before, /analyse customer request/i));
      const gateway = added(ir, before).find((node) => ['xor', 'or'].includes(node.type));
      if (!gateway) return ['no decision gateway was added'];
      if (!reachable(ir, analyse.id, gateway.id)) return ['the new decision is not after analysing the request'];
      const exits = flows(ir).filter((flow) => flow.from === gateway.id);
      if (exits.length < 2) return ['the decision has only one way out'];
      return [];
    },
  },

  // ---- add a parallel branch and rejoin ----
  {
    id: 'T09',
    file: 'miwg/C.7.0.bpmn',
    category: 'parallel',
    prompt:
      'While the advertisement is being published on the homepage, we should also post it to the internal jobs board. Both have to finish before the vacancy counts as advertised.',
    check(ir, before) {
      const fresh = added(ir, before);
      const step = fresh.find((node) => /internal|jobs board|board/i.test(node.name ?? ''));
      if (!step) return ['no step for the internal jobs board'];
      const split = fresh.find((node) => node.type === 'and' && flows(ir).filter((f) => f.from === node.id).length > 1);
      const join = fresh.find((node) => node.type === 'and' && flows(ir).filter((f) => f.to === node.id).length > 1);
      if (!split || !join) return ['the parallel branch is not opened and closed by a pair of gateways'];
      if (!reachable(ir, split.id, step.id) || !reachable(ir, step.id, join.id)) {
        return ['the new step is not on a branch between the split and the join'];
      }
      const homepage = one(find(before, /publish on homepage/i));
      if (!reachable(ir, split.id, homepage.id)) return ['publishing on the homepage is not on the other branch'];
      return [];
    },
  },
  {
    id: 'T10',
    file: 'miwg/C.4.0.bpmn',
    category: 'parallel',
    prompt:
      'Once the responsible department starts preparing for the new employee, ordering the laptop and booking the desk should happen at the same time, and we wait for both.',
    check(ir, before) {
      const fresh = added(ir, before);
      const laptop = fresh.find((node) => /laptop/i.test(node.name ?? ''));
      const desk = fresh.find((node) => /desk/i.test(node.name ?? ''));
      if (!laptop || !desk) return ['both the laptop and the desk step have to exist'];
      const split = fresh.find((node) => node.type === 'and' && reachable(ir, node.id, laptop.id) && reachable(ir, node.id, desk.id));
      const join = fresh.find((node) => node.type === 'and' && reachable(ir, laptop.id, node.id) && reachable(ir, desk.id, node.id));
      if (!split || !join) return ['the two steps are not opened and rejoined by parallel gateways'];
      return [];
    },
  },

  // ---- move a task to another lane ----
  {
    id: 'T11',
    file: 'miwg/C.7.0.bpmn',
    category: 'lane',
    prompt: 'Completing the advertisement should be the hiring manager’s job, not recruitment’s.',
    check(ir, before) {
      const node = one(find(ir, /complete advertisement/i));
      if (!node) return ['the step disappeared'];
      if (laneOf(before, one(find(before, /complete advertisement/i))) !== 'Recruitment') {
        return ['fixture drift: it did not start in Recruitment'];
      }
      if (laneOf(ir, node) !== 'Hiring manager') return [`it is in "${laneOf(ir, node) ?? 'no lane'}"`];
      return [];
    },
  },
  {
    id: 'T12',
    file: 'miwg/C.5.0.bpmn',
    category: 'lane',
    prompt:
      'Checking the customer documents belongs with the Head of Market Service, not with the account manager.',
    check(ir, before) {
      const node = one(find(ir, /check customer documents/i));
      if (!node) return ['the step disappeared'];
      if (laneOf(ir, node) !== 'Head of Market Service') return [`it is in "${laneOf(ir, node) ?? 'no lane'}"`];
      if (added(ir, before).length) return ['nothing should have been added for a move'];
      return [];
    },
  },

  // ---- rename something referenced downstream ----
  {
    id: 'T13',
    file: 'miwg/C.1.1.bpmn',
    category: 'rename',
    prompt: 'We have gone English-only: “Rechnung klären” should read “Clarify invoice”.',
    check(ir, before) {
      const original = one(find(before, /Rechnung/i));
      const node = (ir.nodes ?? []).find((candidate) => candidate.id === original.id);
      if (!node) return ['the id changed — a rename must keep it'];
      if (!/clarify invoice/i.test(node.name ?? '')) return [`it reads "${node.name}"`];
      if ((ir.flows ?? []).length !== flows(before).length) return ['the flows around it changed'];
      return [];
    },
  },
  {
    id: 'T14',
    file: 'miwg/B.2.0.bpmn',
    category: 'rename',
    prompt: '“User Task 3” should be called “Verify submission” from now on.',
    check(ir, before) {
      const original = one(find(before, /^User Task 3$/));
      const node = (ir.nodes ?? []).find((candidate) => candidate.id === original.id);
      if (!node) return ['the id changed — a rename must keep it'];
      if (!/verify submission/i.test(node.name ?? '')) return [`it reads "${node.name}"`];
      return [];
    },
  },

  // ---- edit inside a subprocess ----
  {
    id: 'T15',
    file: 'miwg/A.4.0.bpmn',
    category: 'subprocess',
    prompt:
      'Inside the first expanded sub-process, add a step right after Task 4 and before that sub-process ends.',
    check(ir, before) {
      const sub = one(find(before, /Expanded Sub-Process 1/i));
      const fresh = added(ir, before);
      if (fresh.length !== 1) return [`expected exactly one new node, got ${fresh.length}`];
      if (fresh[0].in !== sub.id) return ['the new step landed outside the sub-process'];
      const task = one(find(before, /^Task 4$/));
      if (!flows(ir).some((flow) => flow.from === task.id && flow.to === fresh[0].id)) {
        return ['the new step does not come right after Task 4'];
      }
      return [];
    },
  },
  {
    id: 'T16',
    file: 'miwg/C.6.0.bpmn',
    category: 'subprocess',
    prompt:
      'Inside “Make Booking”, add a step that records the booking reference right after the flight is booked.',
    check(ir, before) {
      const sub = one(find(before, /make booking/i));
      const flight = one(find(before, /^Book Flight$/i));
      const fresh = added(ir, before);
      if (fresh.length !== 1) return [`expected exactly one new node, got ${fresh.length}`];
      if (fresh[0].in !== sub.id) return ['the new step landed outside Make Booking'];
      if (!flows(ir).some((flow) => flow.from === flight.id && flow.to === fresh[0].id)) {
        return ['the new step does not come right after booking the flight'];
      }
      return [];
    },
  },

  // ---- change a condition expression ----
  {
    id: 'T17',
    file: 'miwg/C.1.0.bpmn',
    category: 'condition',
    prompt:
      'An invoice should only need approval above 1000 euros. Update the condition on the approved path to say so.',
    check(ir, before) {
      const conditioned = flows(before).filter((flow) => flow.if);
      const changed = flows(ir).filter((flow) => {
        const was = conditioned.find((candidate) => candidate.id === flow.id);
        return was && was.if !== flow.if;
      });
      if (changed.length !== 1) return [`expected exactly one condition to change, got ${changed.length}`];
      if (!/1000/.test(changed[0].if ?? '')) return [`the new condition is "${changed[0].if}"`];
      if (added(ir, before).length) return ['nothing should have been added to change a condition'];
      return [];
    },
  },
  {
    id: 'T18',
    file: 'miwg/C.8.1.bpmn',
    category: 'condition',
    prompt:
      'The approval path should also let through anything already marked pre-approved. Widen that condition.',
    check(ir, before) {
      const conditioned = flows(before).filter((flow) => flow.if);
      const changed = flows(ir).filter((flow) => {
        const was = conditioned.find((candidate) => candidate.id === flow.id);
        return was && was.if !== flow.if;
      });
      if (!changed.length) return ['no condition changed'];
      if (changed.length > 1) return [`${changed.length} conditions changed; one was asked for`];
      if ((changed[0].if ?? '').length <= (conditioned.find((c) => c.id === changed[0].id).if ?? '').length) {
        return ['the condition was replaced, not widened'];
      }
      return [];
    },
  },

  // ---- add a message flow between pools ----
  {
    id: 'T19',
    file: 'miwg/C.2.0.bpmn',
    category: 'message',
    prompt: 'The carrier should tell the customer once the truck has been loaded.',
    check(ir, before) {
      const fresh = (ir.messageFlows ?? []).filter(
        (flow) => !(before.messageFlows ?? []).some((old) => old.id === flow.id),
      );
      if (fresh.length !== 1) return [`expected exactly one new message flow, got ${fresh.length}`];
      const truck = one(find(before, /load truck/i));
      if (fresh[0].from !== truck.id) return ['the message does not leave the truck-loading step'];
      const customer = (before.pools ?? []).find((pool) => /customer/i.test(pool.name ?? ''));
      const target = (ir.nodes ?? []).find((node) => node.id === fresh[0].to);
      if (target?.in !== customer.process) return ['the message does not arrive in the customer pool'];
      return [];
    },
  },
  {
    id: 'T20',
    file: 'miwg/C.4.0.bpmn',
    category: 'message',
    prompt:
      'Payroll should let IT know once the employee has been registered, so the accounts can be created.',
    // Kept deliberately: C.4.0 gives every pool its own single-participant collaboration, so there
    // is no one place a message flow between two of them can live. The structured arm refuses this
    // outright. If an arm produces one anyway, the reference gate is what has to catch it.
    check(ir, before) {
      const fresh = (ir.messageFlows ?? []).filter(
        (flow) => !(before.messageFlows ?? []).some((old) => old.id === flow.id),
      );
      if (fresh.length !== 1) return [`expected exactly one new message flow, got ${fresh.length}`];
      const payroll = (before.pools ?? []).find((pool) => /payroll/i.test(pool.name ?? ''));
      const it = (before.pools ?? []).find((pool) => /^IT$/i.test(pool.name ?? ''));
      const from = (ir.nodes ?? []).find((node) => node.id === fresh[0].from);
      const to = (ir.nodes ?? []).find((node) => node.id === fresh[0].to);
      if (from?.in !== payroll.process) return ['the message does not leave the Payroll pool'];
      if (to?.in !== it.process) return ['the message does not arrive in the IT pool'];
      return [];
    },
  },
];

export const byId = new Map(tasks.map((task) => [task.id, task]));
