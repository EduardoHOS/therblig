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
export function risk(plan) {
  return LEVEL[Math.max(0, ...plan.map((operation) => LEVEL.indexOf(riskOf(operation))))];
}

function envelope(op, args, { plan, inverse, minted, removes, footprint, explain }) {
  return {
    op,
    args,
    plan,
    inverse,
    minted,
    ...(removes ? { removes } : {}),
    risk: risk(plan),
    footprint,
    explain,
  };
}

export function insertAfter(ir, args) {
  const { anchor, step, via } = args;
  const node = nodeOf(ir, anchor);
  if (!byIr.has(step.type)) {
    throw precondition('unknown-node-type', `Unknown node type "${step.type}"`);
  }
  if (step.type === 'boundary') {
    throw precondition(
      'step-not-insertable',
      'Step type "boundary" cannot be inserted into a sequence — use timeout or onError',
    );
  }

  const exits = outgoing(ir, anchor);
  if (!exits.length) {
    throw precondition(
      'anchor-no-outgoing',
      `Anchor "${anchor}" has no outgoing flow — use connect to attach the new node`,
    );
  }
  let flow;
  if (via) {
    flow = exits.find((candidate) => candidate.id === via);
    if (!flow) throw precondition('via-not-outgoing', `Flow "${via}" does not leave anchor "${anchor}"`);
  } else {
    if (exits.length > 1) {
      throw precondition(
        'anchor-ambiguous',
        `Anchor "${anchor}" has ${exits.length} outgoing flows — pass via: ${exits.map((exit) => exit.id).join(' | ')}`,
      );
    }
    [flow] = exits;
  }

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

export function timeout(ir, args) {
  const { on, after, to } = args;
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
      { op: 'add', type: 'boundary', event: 'timer', on, in: host.in, id, timer: { duration: after } },
      { op: 'connect', from: id, to, id: flowId },
    ],
    inverse: [{ op: 'del', id }],
    minted: [id, flowId],
    // A boundary sits on its host's edge, so it needs no column of its own.
    footprint: { cols: 0, rows: 0 },
    explain: `If "${nameOf(host)}" exceeds ${after}, continue to "${nameOf(target)}".`,
  });
}

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

export function onError(ir, args) {
  const { on, to } = args;
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
    // the only one expressible without minting a bpmn:Error root element.
    plan: [
      { op: 'add', type: 'boundary', event: 'error', on, in: host.in, id },
      { op: 'connect', from: id, to, id: flowId },
    ],
    inverse: [{ op: 'del', id }],
    minted: [id, flowId],
    footprint: { cols: 0, rows: 0 },
    explain: `If "${nameOf(host)}" fails, continue to "${nameOf(target)}".`,
  });
}

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
