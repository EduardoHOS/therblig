// The IR projection and patch applier — Arm C's entire mechanism, and the prototype
// of therblig's core.
//
// Two rules, both from ADR-001 and ADR-002:
//   1. The moddle tree is the source of truth. The IR is a read-projection.
//      Patches mutate the tree; the IR is never stored.
//   2. Original XML ids are carried verbatim. We mint ids only for elements we create,
//      so the human and the model are always looking at the same document.
import { BpmnModdle } from 'bpmn-moddle';

const TYPE_MAP = new Map([
  ['bpmn:StartEvent', 'start'], ['bpmn:EndEvent', 'end'],
  ['bpmn:IntermediateCatchEvent', 'catch'], ['bpmn:IntermediateThrowEvent', 'throw'],
  ['bpmn:BoundaryEvent', 'boundary'], ['bpmn:Task', 'task'],
  ['bpmn:UserTask', 'user'], ['bpmn:ServiceTask', 'service'],
  ['bpmn:SendTask', 'send'], ['bpmn:ReceiveTask', 'receive'],
  ['bpmn:ManualTask', 'manual'], ['bpmn:ScriptTask', 'script'],
  ['bpmn:BusinessRuleTask', 'rule'], ['bpmn:SubProcess', 'subprocess'],
  ['bpmn:CallActivity', 'call'], ['bpmn:Transaction', 'subprocess'],
  ['bpmn:ExclusiveGateway', 'xor'], ['bpmn:ParallelGateway', 'and'],
  ['bpmn:InclusiveGateway', 'or'], ['bpmn:EventBasedGateway', 'event_gw'],
  ['bpmn:ComplexGateway', 'complex'],
]);
const REVERSE = new Map([...TYPE_MAP].map(([k, v]) => [v, k]));
REVERSE.set('subprocess', 'bpmn:SubProcess');

const EVENT_DEF = new Map([
  ['bpmn:MessageEventDefinition', 'message'], ['bpmn:TimerEventDefinition', 'timer'],
  ['bpmn:ErrorEventDefinition', 'error'], ['bpmn:SignalEventDefinition', 'signal'],
  ['bpmn:EscalationEventDefinition', 'escalation'], ['bpmn:TerminateEventDefinition', 'terminate'],
  ['bpmn:ConditionalEventDefinition', 'conditional'], ['bpmn:CompensateEventDefinition', 'compensate'],
  ['bpmn:LinkEventDefinition', 'link'], ['bpmn:CancelEventDefinition', 'cancel'],
]);

export async function parse(xml) {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  return { moddle, definitions: rootElement };
}

export async function serialize({ moddle, definitions }) {
  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

function* walk(el, seen = new Set()) {
  if (!el || typeof el !== 'object' || seen.has(el)) return;
  seen.add(el);
  yield el;
  for (const k of Object.keys(el)) {
    if (k === '$parent' || k === '$model' || k === '$descriptor') continue;
    const v = el[k];
    if (Array.isArray(v)) for (const c of v) yield* walk(c, seen);
    else if (v && typeof v === 'object') yield* walk(v, seen);
  }
}

export function index(definitions) {
  const byId = new Map();
  for (const el of walk(definitions)) if (el.id) byId.set(el.id, el);
  return byId;
}

// Container id for a flow node: the process or subprocess it lives in.
function containerOf(el) {
  let p = el.$parent;
  while (p && !/^bpmn:(Process|SubProcess|Transaction|AdHocSubProcess)$/.test(p.$type)) p = p.$parent;
  return p?.id ?? null;
}

// Which lane, if any, lists this element. BPMN records this on the lane, not the node.
function laneIndex(definitions) {
  const m = new Map();
  for (const el of walk(definitions)) {
    if (el.$type === 'bpmn:Lane') for (const ref of el.flowNodeRef || []) if (ref?.id) m.set(ref.id, el.id);
  }
  return m;
}

/**
 * Projects the moddle tree into the compact IR the model reads.
 * No coordinates: layout is the server's problem, not the model's.
 */
export function project(definitions, { scope = null } = {}) {
  const lanes = laneIndex(definitions);
  const ir = { processes: [], nodes: [], flows: [], lanes: [], pools: [], messageFlows: [] };

  for (const el of walk(definitions)) {
    const t = el.$type;
    if (t === 'bpmn:Process') ir.processes.push({ id: el.id, name: el.name ?? null, executable: el.isExecutable ?? null });
    else if (t === 'bpmn:Participant') ir.pools.push({ id: el.id, name: el.name ?? null, process: el.processRef?.id ?? null });
    else if (t === 'bpmn:Lane') ir.lanes.push({ id: el.id, name: el.name ?? null, in: containerOf(el) });
    else if (t === 'bpmn:MessageFlow') ir.messageFlows.push({ id: el.id, name: el.name ?? null, from: el.sourceRef?.id, to: el.targetRef?.id });
    else if (t === 'bpmn:SequenceFlow') {
      const f = { id: el.id, from: el.sourceRef?.id, to: el.targetRef?.id };
      if (el.name) f.name = el.name;
      if (el.conditionExpression?.body) f.if = el.conditionExpression.body;
      ir.flows.push(f);
    } else if (TYPE_MAP.has(t)) {
      const n = { id: el.id, type: TYPE_MAP.get(t) };
      if (el.name) n.name = el.name;
      const inC = containerOf(el);
      if (inC) n.in = inC;
      if (lanes.has(el.id)) n.lane = lanes.get(el.id);
      if (el.attachedToRef?.id) n.on = el.attachedToRef.id;
      const defs = (el.eventDefinitions || []).map((d) => EVENT_DEF.get(d.$type) || d.$type).filter(Boolean);
      if (defs.length) n.event = defs.length === 1 ? defs[0] : defs;
      if (el.default?.id) n.default = el.default.id;
      if (el.cancelActivity === false) n.interrupting = false;
      if (el.triggeredByEvent) n.eventSubprocess = true;
      if (el.extensionElements?.values?.length) n.ext = el.extensionElements.values.map((v) => v.$type);
      ir.nodes.push(n);
    }
  }

  if (scope) {
    const keep = new Set([scope, ...ir.nodes.filter((n) => n.in === scope).map((n) => n.id)]);
    ir.nodes = ir.nodes.filter((n) => keep.has(n.id) || keep.has(n.on));
    const ids = new Set(ir.nodes.map((n) => n.id));
    ir.flows = ir.flows.filter((f) => ids.has(f.from) && ids.has(f.to));
  }
  for (const k of Object.keys(ir)) if (!ir[k].length) delete ir[k];
  return ir;
}

// --- patch ops -------------------------------------------------------------
// Deliberately four: add, set, del, connect. Anything more is where subtle
// correctness bugs live, and none of it is needed to be useful.

function mintId(byId, base) {
  const slug = String(base).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'Element';
  let id = slug, n = 1;
  while (byId.has(id)) id = `${slug}_${++n}`;
  return id;
}

function flowNodesOf(container) {
  if (!container.flowElements) container.flowElements = [];
  return container.flowElements;
}

// BPMN stores adjacency twice: on the flow (sourceRef/targetRef) and on each node
// (<incoming>/<outgoing> children). moddle does not maintain the inverse when you
// set sourceRef/targetRef programmatically, and bpmnlint reads the node side — so a
// flow written only one way produces a node that is valid XML but lints as
// disconnected. Every mutation below goes through these three helpers.
function linkFlow(flow, from, to) {
  flow.sourceRef = from;
  flow.targetRef = to;
  if (from) { (from.outgoing ??= []); if (!from.outgoing.includes(flow)) from.outgoing.push(flow); }
  if (to) { (to.incoming ??= []); if (!to.incoming.includes(flow)) to.incoming.push(flow); }
}

function unlinkFlow(flow) {
  const from = flow.sourceRef, to = flow.targetRef;
  if (from?.outgoing) { const i = from.outgoing.indexOf(flow); if (i >= 0) from.outgoing.splice(i, 1); }
  if (to?.incoming) { const i = to.incoming.indexOf(flow); if (i >= 0) to.incoming.splice(i, 1); }
}

function retarget(flow, to) {
  const old = flow.targetRef;
  if (old?.incoming) { const i = old.incoming.indexOf(flow); if (i >= 0) old.incoming.splice(i, 1); }
  flow.targetRef = to;
  (to.incoming ??= []);
  if (!to.incoming.includes(flow)) to.incoming.push(flow);
}

export function applyPatch({ moddle, definitions }, ops) {
  const byId = index(definitions);
  const changed = new Set();
  const created = [];

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const type = REVERSE.get(op.type);
        if (!type) throw new Error(`unknown node type "${op.type}"`);
        const container = byId.get(op.in);
        if (!container) throw new Error(`container "${op.in}" not found`);
        const id = op.id && !byId.has(op.id) ? op.id : mintId(byId, op.id || op.name || op.type);
        const el = moddle.create(type, { id, ...(op.name ? { name: op.name } : {}) });
        if (op.event) {
          const defType = [...EVENT_DEF].find(([, v]) => v === op.event)?.[0];
          if (!defType) throw new Error(`unknown event kind "${op.event}"`);
          const def = moddle.create(defType, {});
          def.$parent = el;
          el.eventDefinitions = [def];
        }
        if (op.on) {
          const host = byId.get(op.on);
          if (!host) throw new Error(`boundary host "${op.on}" not found`);
          el.attachedToRef = host;
          if (op.interrupting === false) el.cancelActivity = false;
        }
        el.$parent = container;
        flowNodesOf(container).push(el);
        byId.set(id, el);
        changed.add(id);
        created.push(id);
        // splice sugar: insert between two nodes, rewiring the flow that joined them
        if (op.after || op.between) {
          const [a, b] = op.between ?? [op.after, null];
          const src = byId.get(a);
          if (!src) throw new Error(`node "${a}" not found`);
          const existing = (container.flowElements || []).filter(
            (f) => f.$type === 'bpmn:SequenceFlow' && f.sourceRef?.id === a && (!b || f.targetRef?.id === b)
          );
          const target = b ? byId.get(b) : existing[0]?.targetRef;
          for (const f of existing) { retarget(f, el); changed.add(f.id); }
          if (target) {
            const fid = mintId(byId, `Flow_${id}`);
            const nf = moddle.create('bpmn:SequenceFlow', { id: fid });
            linkFlow(nf, el, target);
            nf.$parent = container;
            flowNodesOf(container).push(nf);
            byId.set(fid, nf);
            changed.add(fid);
            created.push(fid);
          }
        }
        break;
      }
      case 'set': {
        const el = byId.get(op.id);
        if (!el) throw new Error(`element "${op.id}" not found`);
        for (const [k, v] of Object.entries(op.patch ?? {})) {
          if (k === 'if') {
            el.conditionExpression = v == null ? undefined : moddle.create('bpmn:FormalExpression', { body: v });
            if (el.conditionExpression) el.conditionExpression.$parent = el;
          } else if (k === 'default') {
            el.default = byId.get(v);
          } else el[k] = v;
        }
        changed.add(op.id);
        break;
      }
      case 'del': {
        const el = byId.get(op.id);
        if (!el) throw new Error(`element "${op.id}" not found`);
        const container = el.$parent;
        const kill = new Set([el]);
        // cascade: flows touching it, and boundary events attached to it
        for (const other of walk(definitions)) {
          if (other.$type === 'bpmn:SequenceFlow' && (other.sourceRef === el || other.targetRef === el)) kill.add(other);
          if (other.attachedToRef === el) kill.add(other);
        }
        for (const victim of kill) {
          if (victim.$type === 'bpmn:SequenceFlow') unlinkFlow(victim);
          const arr = victim.$parent?.flowElements;
          if (arr) { const i = arr.indexOf(victim); if (i >= 0) arr.splice(i, 1); }
          for (const lane of walk(definitions)) {
            if (lane.$type === 'bpmn:Lane' && lane.flowNodeRef) {
              const i = lane.flowNodeRef.indexOf(victim);
              if (i >= 0) lane.flowNodeRef.splice(i, 1);
            }
          }
          byId.delete(victim.id);
          changed.add(victim.id);
        }
        if (container) changed.add(container.id);
        break;
      }
      case 'connect': {
        const from = byId.get(op.from), to = byId.get(op.to);
        if (!from) throw new Error(`source "${op.from}" not found`);
        if (!to) throw new Error(`target "${op.to}" not found`);
        if (op.remove) {
          for (const f of [...walk(definitions)]) {
            if (f.$type === 'bpmn:SequenceFlow' && f.sourceRef === from && f.targetRef === to) {
              unlinkFlow(f);
              const arr = f.$parent?.flowElements;
              if (arr) { const i = arr.indexOf(f); if (i >= 0) arr.splice(i, 1); }
              changed.add(f.id);
            }
          }
          break;
        }
        const container = from.$parent;
        const id = op.id && !byId.has(op.id) ? op.id : mintId(byId, `Flow_${op.from}_${op.to}`);
        const flow = moddle.create('bpmn:SequenceFlow', { id, ...(op.name ? { name: op.name } : {}) });
        linkFlow(flow, from, to);
        if (op.if) {
          flow.conditionExpression = moddle.create('bpmn:FormalExpression', { body: op.if });
          flow.conditionExpression.$parent = flow;
        }
        flow.$parent = container;
        flowNodesOf(container).push(flow);
        byId.set(id, flow);
        changed.add(id);
        created.push(id);
        break;
      }
      default:
        throw new Error(`unknown op "${op.op}"`);
    }
  }
  return { changed: [...changed], created };
}
