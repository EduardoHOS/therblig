import { mintId } from './patch.mjs';
import { BPMN_TYPE_BY_NODE } from './vocabulary.mjs';

// An op compiles intent into a plan of primitives. It reads the IR, never the tree: everything
// it emits is applied by patch.mjs, so an op can add height to the API without adding risk.

const PRIMITIVES = new Set(['add', 'set', 'del', 'connect']);
const ACTIVITY = new Set([
  'task', 'user', 'service', 'send', 'receive', 'manual', 'script', 'rule', 'subprocess', 'call',
]);
// Keys of `set` that change where a token goes; everything else on `set` is cosmetic.
const ROUTING_KEYS = new Set(['if', 'default', 'to']);
const LEVEL = ['safe', 'additive', 'routing', 'destructive'];
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

function precondition(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
  return (ir.flows ?? []).filter((flow) => flow.from === id);
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

function envelope(op, args, { plan, inverse, minted, footprint, explain }) {
  return { op, args, plan, inverse, minted, risk: risk(plan), footprint, explain };
}

export function insertAfter(ir, args) {
  const { anchor, step, via } = args;
  const node = nodeOf(ir, anchor);
  if (!BPMN_TYPE_BY_NODE.has(step.type)) {
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
