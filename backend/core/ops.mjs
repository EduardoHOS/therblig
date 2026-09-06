/**
 * What an op returns. Every field is derived from the plan or from the IR: nothing here is the
 * op's opinion of itself, which is why `risk` cannot drift from what the plan actually does.
 *
 * @typedef {'safe' | 'additive' | 'routing' | 'destructive'} RiskLevel
 *
 * @typedef {object} Envelope
 * @property {string} op
 * @property {Record<string, unknown>} args
 * @property {import('./patch.mjs').Operation[]} plan
 * @property {import('./patch.mjs').Operation[]} inverse
 * @property {string[]} minted                 ids this plan will create
 * @property {string[]} [removes]              ids `del` will cascade, beyond the named one
 * @property {{split: string, join: string}} [result]
 * @property {RiskLevel} risk
 * @property {{cols: number, rows: number}} footprint
 * @property {string} explain                  one sentence, in the file's own names
 *
 * @typedef {object} Step
 * @property {string} type                     an IR word from the block registry
 * @property {string} [name]
 */

import { mintId } from './patch.mjs';
import { byIr } from './registry.mjs';

// An op compiles intent into a plan of primitives. It reads the IR, never the tree: everything
// it emits is applied by patch.mjs, so an op can add height to the API without adding risk.

const PRIMITIVES = new Set(['add', 'set', 'del', 'connect']);
const ACTIVITY = new Set([
  'task', 'user', 'service', 'send', 'receive', 'manual', 'script', 'rule', 'subprocess', 'call',
]);
const GATEWAY = new Set(['xor', 'and', 'or', 'event_gw', 'complex']);
// Keys that change where a token goes — or who executes the step.
const ROUTING_KEYS = new Set(['if', 'default', 'to', 'lane']);
const LEVEL = ['safe', 'additive', 'routing', 'destructive'];
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

function precondition(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const list = (ir, key) => ir[key] ?? [];

function elements(ir) {
  return Object.values(ir).flat();
}

function idsOf(ir) {
  return new Set(elements(ir).map((element) => element.id));
}

function elementOf(ir, id) {
  const element = elements(ir).find((candidate) => candidate.id === id);
  if (!element) throw precondition('element-not-found', `Element "${id}" not found`);
  return element;
}

function nodeOf(ir, id) {
  const node = elements(ir).find((candidate) => candidate.id === id && candidate.type);
  if (!node) throw precondition('element-not-found', `Node "${id}" not found`);
  return node;
}

function nameOf(element) {
  return element.name ?? element.id;
}

function outgoing(ir, id) {
  return list(ir, 'flows').filter((flow) => flow.from === id);
}

function riskOf(operation) {
  if (!PRIMITIVES.has(operation.op)) throw new Error(`Unknown operation "${operation.op}"`);
  if (operation.op === 'del' || operation.remove) return 'destructive';
  if (operation.op === 'add' || operation.op === 'connect') return 'additive';
  return Object.keys(operation.patch ?? {}).some((key) => ROUTING_KEYS.has(key)) ? 'routing' : 'safe';
}

// Risk is a function of the plan, never declared by the op: declared risk drifts, computed cannot.
/** @param {import('./patch.mjs').Operation[]} plan @returns {RiskLevel} */
export function risk(plan) {
  return LEVEL[Math.max(0, ...plan.map((operation) => LEVEL.indexOf(riskOf(operation))))];
}

function envelope(op, args, { plan, inverse, minted, removes, result, footprint, explain }) {
  return {
    op,
    args,
    plan,
    inverse,
    minted,
    ...(removes ? { removes } : {}),
    ...(result ? { result } : {}),
    risk: risk(plan),
    footprint,
    explain,
  };
}

// The single flow leaving an anchor, or a named refusal: an anchor with two exits has no
// "after" until the caller says which one.
function exitOf(ir, anchor, via) {
  const exits = outgoing(ir, anchor);
  if (!exits.length) {
    throw precondition(
      'anchor-no-outgoing',
      `Anchor "${anchor}" has no outgoing flow — use connect to attach the new node`,
    );
  }
  if (via) {
    const chosen = exits.find((candidate) => candidate.id === via);
    if (chosen) return chosen;
    throw precondition('via-not-outgoing', `Flow "${via}" does not leave anchor "${anchor}"`);
  }
  if (exits.length > 1) {
    throw precondition(
      'anchor-ambiguous',
      `Anchor "${anchor}" has ${exits.length} outgoing flows — pass via: ${exits.map((exit) => exit.id).join(' | ')}`,
    );
  }
  return exits[0];
}

function assertInsertable(step) {
  if (!byIr.has(step.type)) {
    throw precondition('unknown-node-type', `Unknown node type "${step.type}"`);
  }
  if (step.type === 'boundary') {
    throw precondition(
      'step-not-insertable',
      'Step type "boundary" cannot be inserted into a sequence — use timeout or onError',
    );
  }
}

/** @param {import('./projection.mjs').Projection} ir @param {{anchor: string, step: Step, via?: string}} args @returns {Envelope} */
export function insertAfter(ir, args) {
  const { anchor, step, via } = args;
  const node = nodeOf(ir, anchor);
  assertInsertable(step);

  const flow = exitOf(ir, anchor, via);

  const ids = idsOf(ir);
  const id = mintId(ids, step.name ?? step.type);
  ids.add(id);
  const flowId = mintId(ids, `Flow_${id}`);
  const target = nodeOf(ir, flow.to);

  return envelope('insertAfter', args, {
    // `between` makes patch.mjs retarget the existing flow and mint the second one.
    plan: [
      { op: 'add', type: step.type, ...(step.name ? { name: step.name } : {}), id, in: node.in, between: [anchor, flow.to] },
    ],
    // Retarget the original flow first so `del` cascades only the minted one.
    inverse: [{ op: 'set', id: flow.id, patch: { to: flow.to } }, { op: 'del', id }],
    minted: [id, flowId],
    footprint: { cols: 1, rows: 0 },
    explain: `Inserted "${step.name ?? id}" between "${nameOf(node)}" and "${nameOf(target)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{on: string, after: string, to: string, name?: string}} args @returns {Envelope} */
export function timeout(ir, args) {
  const { on, after, to, name } = args;
  const host = nodeOf(ir, on);
  if (!ACTIVITY.has(host.type)) throw precondition('host-not-activity', `Host "${on}" is not an activity`);
  const target = nodeOf(ir, to);
  if (target.in !== host.in) {
    throw precondition('target-outside-container', `Target "${to}" is outside the container of "${on}"`);
  }
  if (!ISO_DURATION.test(after)) throw precondition('invalid-duration', `Duration "${after}" is not ISO-8601`);

  const ids = idsOf(ir);
  const id = mintId(ids, `${on}_timeout`);
  ids.add(id);
  const flowId = mintId(ids, `Flow_${id}`);

  return envelope('timeout', args, {
    plan: [
      {
        op: 'add',
        type: 'boundary',
        event: 'timer',
        ...(name ? { name } : {}),
        on,
        in: host.in,
        id,
        timer: { duration: after },
      },
      { op: 'connect', from: id, to, id: flowId },
    ],
    inverse: [{ op: 'del', id }],
    minted: [id, flowId],
    // A boundary sits on its host's edge, so it needs no column of its own.
    footprint: { cols: 0, rows: 0 },
    explain: `If "${nameOf(host)}" exceeds ${after}, continue to "${nameOf(target)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{id: string, name: string}} args @returns {Envelope} */
export function rename(ir, args) {
  const { id, name } = args;
  const element = elementOf(ir, id);
  if (typeof name !== 'string' || !name.trim()) {
    throw precondition('invalid-name', 'Name must be a non-empty string');
  }

  return envelope('rename', args, {
    plan: [{ op: 'set', id, patch: { name } }],
    inverse: [{ op: 'set', id, patch: { name: element.name ?? null } }],
    minted: [],
    footprint: { cols: 0, rows: 0 },
    explain: `Renamed "${nameOf(element)}" to "${name}".`,
  });
}

function flowOf(ir, id) {
  const flow = list(ir, 'flows').find((candidate) => candidate.id === id);
  if (flow) return flow;
  elementOf(ir, id);
  throw precondition('not-a-flow', `Element "${id}" is not a flow`);
}

function incoming(ir, id) {
  return list(ir, 'flows').filter((flow) => flow.to === id);
}

/** @param {import('./projection.mjs').Projection} ir @param {{id: string}} args @returns {Envelope} */
export function bypass(ir, args) {
  const { id } = args;
  const node = nodeOf(ir, id);
  const into = incoming(ir, id);
  const out = outgoing(ir, id);
  if (into.length !== 1 || out.length !== 1) {
    throw precondition(
      'heal-ambiguous',
      `Node "${id}" has ${into.length} incoming and ${out.length} outgoing flows — healing the path would be a guess; use del`,
    );
  }
  // An op promises an exact inverse, and the IR does not carry a timer's duration or an error
  // code, so re-adding a cascaded boundary could not restore it. Refuse rather than lose it.
  const boundaries = list(ir, 'nodes').filter((candidate) => candidate.on === id);
  if (boundaries.length) {
    throw precondition(
      'has-boundary',
      `Node "${id}" carries boundary events (${boundaries.map((b) => b.id).join(', ')}) — remove them first, or use del`,
    );
  }

  const [entry] = into;
  const [exit] = out;
  const predecessor = nodeOf(ir, entry.from);
  const successor = nodeOf(ir, exit.to);

  return envelope('bypass', args, {
    // Retarget the surviving flow, then delete: `del` cascades the now-orphaned exit.
    plan: [
      { op: 'set', id: entry.id, patch: { to: exit.to } },
      { op: 'del', id },
    ],
    inverse: [
      { op: 'add', type: node.type, ...(node.name ? { name: node.name } : {}), id, in: node.in },
      { op: 'set', id: entry.id, patch: { to: id } },
      { op: 'connect', from: id, to: exit.to, id: exit.id },
    ],
    minted: [],
    removes: [id, exit.id],
    footprint: { cols: -1, rows: 0 },
    explain: `Removed "${nameOf(node)}"; "${nameOf(predecessor)}" now continues to "${nameOf(successor)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{on: string, to: string, name?: string}} args @returns {Envelope} */
export function onError(ir, args) {
  const { on, to, name } = args;
  const host = nodeOf(ir, on);
  if (!ACTIVITY.has(host.type)) throw precondition('host-not-activity', `Host "${on}" is not an activity`);
  const target = nodeOf(ir, to);
  if (target.in !== host.in) {
    throw precondition('target-outside-container', `Target "${to}" is outside the container of "${on}"`);
  }

  const ids = idsOf(ir);
  const id = mintId(ids, `${on}_error`);
  ids.add(id);
  const flowId = mintId(ids, `Flow_${id}`);

  return envelope('onError', args, {
    // No errorRef: a bare ErrorEventDefinition catches any error, which is the common case and
    // the only one expressible without minting a bpmn:Error root element. `name` labels the
    // handler — bpmnlint reports an unlabelled one, and a reader cannot tell what it catches.
    plan: [
      { op: 'add', type: 'boundary', event: 'error', ...(name ? { name } : {}), on, in: host.in, id },
      { op: 'connect', from: id, to, id: flowId },
    ],
    inverse: [{ op: 'del', id }],
    minted: [id, flowId],
    footprint: { cols: 0, rows: 0 },
    explain: `If "${nameOf(host)}" fails, continue to "${nameOf(target)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{id: string, lane: string}} args @returns {Envelope} */
export function moveToLane(ir, args) {
  const { id, lane } = args;
  const node = nodeOf(ir, id);
  const target = list(ir, 'lanes').find((candidate) => candidate.id === lane);
  if (!target) {
    elementOf(ir, lane);
    throw precondition('not-a-lane', `Element "${lane}" is not a lane`);
  }
  if (target.in !== node.in) {
    throw precondition(
      'lane-in-another-pool',
      `Lane "${lane}" is not in the container of "${id}" — use message to reach another pool`,
    );
  }

  const previous = list(ir, 'lanes').find((candidate) => candidate.id === node.lane);
  return envelope('moveToLane', args, {
    plan: [{ op: 'set', id, patch: { lane } }],
    inverse: [{ op: 'set', id, patch: { lane: node.lane ?? null } }],
    minted: [],
    footprint: { cols: 0, rows: 0 },
    explain: previous
      ? `Moved "${nameOf(node)}" from "${nameOf(previous)}" to "${nameOf(target)}".`
      : `Moved "${nameOf(node)}" into "${nameOf(target)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{flow: string, if?: string, default?: boolean}} args @returns {Envelope} */
export function guard(ir, args) {
  const { flow: flowId, if: condition, default: isDefault } = args;
  if ((condition == null) === (isDefault == null)) {
    throw precondition('guard-underspecified', 'Pass exactly one of if or default');
  }
  const flow = flowOf(ir, flowId);
  const source = nodeOf(ir, flow.from);
  if (!GATEWAY.has(source.type)) {
    throw precondition('condition-ignored', `Flow "${flowId}" does not leave a gateway, so a guard on it would never be read`);
  }

  if (condition != null) {
    return envelope('guard', args, {
      plan: [{ op: 'set', id: flowId, patch: { if: condition } }],
      inverse: [{ op: 'set', id: flowId, patch: { if: flow.if ?? null } }],
      minted: [],
      footprint: { cols: 0, rows: 0 },
      explain: `From "${nameOf(source)}", take "${flowId}" when ${condition}.`,
    });
  }

  return envelope('guard', args, {
    plan: [{ op: 'set', id: source.id, patch: { default: flowId } }],
    inverse: [{ op: 'set', id: source.id, patch: { default: source.default ?? null } }],
    minted: [],
    footprint: { cols: 0, rows: 0 },
    explain: `From "${nameOf(source)}", take "${flowId}" when nothing else applies.`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{from: string, to: string, name?: string}} args @returns {Envelope} */
export function message(ir, args) {
  const { from, to, name } = args;
  const source = nodeOf(ir, from);
  const target = nodeOf(ir, to);
  if (source.in === target.in) {
    throw precondition(
      'same-container',
      `"${from}" and "${to}" are in the same container — use insertAfter or connect`,
    );
  }

  const poolOf = (node) =>
    list(ir, 'pools').find((pool) => pool.process === node.in) ?? { name: node.in };
  const id = mintId(idsOf(ir), `Message_${from}_${to}`);

  return envelope('message', args, {
    plan: [{ op: 'connect', from, to, id, ...(name ? { name } : {}) }],
    inverse: [{ op: 'connect', from, to, remove: true }],
    minted: [id],
    footprint: { cols: 0, rows: 0 },
    explain: `${nameOf(poolOf(source))} sends ${name ? `"${name}" ` : ''}from "${nameOf(source)}" to "${nameOf(target)}" in ${nameOf(poolOf(target))}.`,
  });
}

// A fork mints its split and join as a pair, so an unbalanced gateway stops being expressible at
// this height. `connect` stays available for the shapes the catalogue does not cover.
function fork(ir, args, { op, kind, anchor, via, branches, condition, label, name, straightFirst = false }) {
  const node = nodeOf(ir, anchor);
  if (branches.length < 2) {
    throw precondition('too-few-branches', `A ${op} needs at least 2 branches — use insertAfter`);
  }
  branches.forEach((steps, index) => {
    // A branch may be empty in exactly one place: the straight-through default of an xor, where
    // the direct split→join flow is the path. Everywhere else it is a gateway pair for nothing.
    if (!steps.length && !(straightFirst && index === 0)) {
      throw precondition('empty-branch', `Branch ${index + 1} is empty`);
    }
    for (const step of steps) assertInsertable(step);
  });

  const spine = exitOf(ir, anchor, via);
  const successor = nodeOf(ir, spine.to);
  const ids = idsOf(ir);
  const mint = (base) => {
    const id = mintId(ids, base);
    ids.add(id);
    return id;
  };

  // Mint in the order patch.mjs will: a node, then the flow that `between` makes for it.
  const split = mint(`${kind}_split_${anchor}`);
  const splitFlow = mint(`Flow_${split}`);
  const join = mint(`${kind}_join_${anchor}`);
  const joinFlow = mint(`Flow_${join}`);
  const minted = [split, splitFlow, join, joinFlow];

  const plan = [
    { op: 'add', type: kind, ...(name ? { name } : {}), id: split, in: node.in, between: [anchor, spine.to] },
    { op: 'add', type: kind, id: join, in: node.in, between: [split, spine.to] },
  ];

  branches.forEach((steps, index) => {
    let previous = split;
    steps.forEach((step, position) => {
      const id = mint(step.name ?? step.type);
      const named = step.name ? { name: step.name } : {};
      if (index === 0) {
        // The first branch consumes the direct split→join flow, so `splitFlow` ends up leaving
        // the split along it — which is exactly what a default has to be.
        plan.push({ op: 'add', type: step.type, ...named, id, in: node.in, between: [previous, join] });
        minted.push(id, mint(`Flow_${id}`));
      } else {
        const inflow = mint(`Flow_${id}_in`);
        plan.push({ op: 'add', type: step.type, ...named, id, in: node.in });
        plan.push({
          op: 'connect',
          from: previous,
          to: id,
          id: inflow,
          ...(position === 0 && condition ? { if: condition } : {}),
          ...(position === 0 && label ? { name: label } : {}),
        });
        minted.push(id, inflow);
        if (position === steps.length - 1) {
          const outflow = mint(`Flow_${id}_out`);
          plan.push({ op: 'connect', from: id, to: join, id: outflow });
          minted.push(outflow);
        }
      }
      previous = id;
    });
  });

  if (condition) plan.push({ op: 'set', id: split, patch: { default: splitFlow } });

  return {
    node,
    successor,
    split,
    join,
    plan,
    minted,
    cols: 2 + Math.max(...branches.map((steps) => steps.length)),
    rows: branches.length,
    // `del` on a gateway cascades every flow touching it, and those flows cascade the branch
    // nodes, so deleting the pair is the whole undo.
    inverse: [
      { op: 'set', id: spine.id, patch: { to: spine.to } },
      { op: 'del', id: split },
      { op: 'del', id: join },
    ],
  };
}

const chain = (steps) => steps.map((step) => `"${step.name ?? step.type}"`).join(' then ');

/** @param {import('./projection.mjs').Projection} ir @param {{anchor: string, when: string, yes: Step[], no?: Step[], via?: string, name?: string, label?: string}} args @returns {Envelope} */
export function branch(ir, args) {
  const { anchor, when, yes = [], no, via, name, label } = args;
  if (!when) throw precondition('missing-condition', 'A branch needs a condition — pass when');
  if (!yes.length) throw precondition('empty-branch', 'The yes branch is empty');

  // The "no" path goes first so it keeps the direct split→join flow, which is what the default
  // has to be — whether that path carries steps or goes straight through.
  const straight = !no;
  const built = fork(ir, args, {
    op: 'branch',
    kind: 'xor',
    anchor,
    via,
    branches: [no ?? [], yes],
    condition: when,
    // A diverging gateway and its conditional exit read as unlabelled decisions without these,
    // which bpmnlint reports and a human cannot follow. The op never invents them.
    label,
    name,
    straightFirst: straight,
  });

  return envelope('branch', args, {
    plan: built.plan,
    inverse: built.inverse,
    minted: built.minted,
    footprint: { cols: built.cols, rows: 2 },
    result: { split: built.split, join: built.join },
    explain: `After "${nameOf(built.node)}", take ${chain(yes)} when ${when}, and otherwise ${
      straight ? 'carry straight on' : chain(no)
    }; both rejoin before "${nameOf(built.successor)}".`,
  });
}

/** @param {import('./projection.mjs').Projection} ir @param {{anchor: string, branches: Step[][], via?: string}} args @returns {Envelope} */
export function parallel(ir, args) {
  const { anchor, branches = [], via } = args;
  const built = fork(ir, args, { op: 'parallel', kind: 'and', anchor, via, branches });

  return envelope('parallel', args, {
    plan: built.plan,
    inverse: built.inverse,
    minted: built.minted,
    footprint: { cols: built.cols, rows: built.rows },
    result: { split: built.split, join: built.join },
    explain: `After "${nameOf(built.node)}", run ${branches
      .map(chain)
      .join(' and ')} at the same time; all rejoin before "${nameOf(built.successor)}".`,
  });
}
