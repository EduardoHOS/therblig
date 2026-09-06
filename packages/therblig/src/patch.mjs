// The four patch ops, and the invariants that make them safe.
//
// BPMN stores adjacency twice — on the flow (sourceRef/targetRef) and on each endpoint
// (<incoming>/<outgoing>) — and moddle maintains only the flow side. Every mutation
// here routes through linkFlow / unlinkFlow / retarget, which maintain both. See F8.
import { walk, index } from './model.mjs';
import { REVERSE, EVENT_DEF } from './ir.mjs';
import { TherbligError } from './errors.mjs';

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

// What `set` may write. Closed on purpose. The open fallthrough this replaces
// assigned any key straight onto the moddle object, so a caller could put a string
// where an element reference belongs (D1) or a string where a typed child collection
// belongs (D2), and neither failed until serialize — or, worse, didn't fail at all.
// `if`, `default` and `documentation` are handled separately because each needs a
// typed construction rather than an assignment.
const SETTABLE = new Set([
  'name', 'if', 'default', 'documentation',
  'isExecutable', 'isForCompensation', 'isInterrupting', 'cancelActivity',
  'triggeredByEvent', 'completionQuantity', 'startQuantity',
]);

// Rejected with an explanation rather than silently mangled. `id` is here because
// ADR-002 carries original ids verbatim: renaming one breaks every reference to it,
// and the human has the file open in a modeller that shows that id.
const ADJACENCY = new Set([
  'sourceRef', 'targetRef', 'incoming', 'outgoing',
  'attachedToRef', 'flowNodeRef', 'id', '$type', '$parent',
]);

export function applyPatch({ moddle, definitions }, ops) {
  const byId = index(definitions);
  const changed = new Set();
  const created = [];

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const type = REVERSE.get(op.type);
        if (!type) throw new TherbligError('THB_UNKNOWN_TYPE', `unknown node type "${op.type}"`);
        const container = byId.get(op.in);
        if (!container) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `container "${op.in}" not found`);
        const id = op.id && !byId.has(op.id) ? op.id : mintId(byId, op.id || op.name || op.type);
        const el = moddle.create(type, { id, ...(op.name ? { name: op.name } : {}) });
        if (op.event) {
          const defType = [...EVENT_DEF].find(([, v]) => v === op.event)?.[0];
          if (!defType) throw new TherbligError('THB_UNKNOWN_TYPE', `unknown event kind "${op.event}"`);
          const def = moddle.create(defType, {});
          def.$parent = el;
          el.eventDefinitions = [def];
        }
        if (op.on) {
          const host = byId.get(op.on);
          if (!host) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `boundary host "${op.on}" not found`);
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
          if (!src) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `node "${a}" not found`);
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
        if (!el) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `element "${op.id}" not found`);
        for (const [k, v] of Object.entries(op.patch ?? {})) {
          if (k === 'if') {
            el.conditionExpression = v == null ? undefined : moddle.create('bpmn:FormalExpression', { body: v });
            if (el.conditionExpression) el.conditionExpression.$parent = el;
          } else if (k === 'default') {
            const target = byId.get(v);
            if (v != null && !target) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `default flow "${v}" not found`);
            el.default = target;
          } else if (k === 'documentation') {
            // bpmn:Documentation is a typed child collection, not a string attribute.
            // The old fallthrough assigned the bare string and moddle threw
            // "Cannot read properties of undefined (reading 'isGeneric')" at serialize
            // time — after the edit had already been applied. See FINDINGS.md F12 (D2).
            if (v == null || v === '') el.documentation = undefined;
            else {
              const doc = moddle.create('bpmn:Documentation', { text: String(v) });
              doc.$parent = el;
              el.documentation = [doc];
            }
          } else if (ADJACENCY.has(k)) {
            // F8 states as a product invariant that no code path may set sourceRef or
            // targetRef directly, because adjacency lives in two places and moddle
            // maintains only one. Nothing enforced it: `set {targetRef: 'X'}` put an
            // id STRING where an element REFERENCE belongs and serialized
            // targetRef="undefined" — a silently corrupted graph that passed all five
            // gates. See FINDINGS.md F12 (D1).
            throw new TherbligError('THB_FORBIDDEN_FIELD',
              `"${k}" cannot be set directly — adjacency lives on both the flow and its ` +
              `endpoints, and writing one side corrupts the graph. Use connect/del instead.`);
          } else if (!SETTABLE.has(k)) {
            throw new TherbligError('THB_FORBIDDEN_FIELD',
              `"${k}" is not settable. Allowed: ${[...SETTABLE].sort().join(', ')}. ` +
              `A closed list is deliberate: the open fallthrough it replaces wrote any ` +
              `key verbatim onto the moddle object, which is how D1 and D2 happened.`);
          } else el[k] = v;
        }
        changed.add(op.id);
        break;
      }
      case 'del': {
        const el = byId.get(op.id);
        if (!el) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `element "${op.id}" not found`);
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
        if (!from) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `source "${op.from}" not found`);
        if (!to) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `target "${op.to}" not found`);
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
      case 'move': {
        // Lane membership is recorded on the LANE, as a list of flowNodeRef, not on the
        // node. That is why `set {patch:{lane}}` was never going to work and why the
        // allowlist refuses it: there is no property on the node to write. Moving is its
        // own operation because it is two edits — one lane loses the reference, another
        // gains it — and doing only half leaves the node in both or neither.
        const el = byId.get(op.id);
        if (!el) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `element "${op.id}" not found`);
        if (typeof op.lane !== 'string') {
          throw new TherbligError('THB_UNKNOWN_TYPE', 'move needs a "lane" to move into');
        }
        const lane = byId.get(op.lane);
        if (!lane) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `lane "${op.lane}" not found`);
        if (lane.$type !== 'bpmn:Lane') {
          throw new TherbligError('THB_UNKNOWN_TYPE', `"${op.lane}" is a ${lane.$type.replace('bpmn:', '')}, not a lane`);
        }
        for (const other of walk(definitions)) {
          if (other.$type !== 'bpmn:Lane' || !other.flowNodeRef) continue;
          const i = other.flowNodeRef.indexOf(el);
          if (i >= 0 && other !== lane) { other.flowNodeRef.splice(i, 1); changed.add(other.id); }
        }
        (lane.flowNodeRef ??= []);
        if (!lane.flowNodeRef.includes(el)) lane.flowNodeRef.push(el);
        changed.add(lane.id);
        changed.add(el.id);
        break;
      }
      case 'message': {
        // Only a message flow may cross a pool boundary, and it lives on the
        // collaboration rather than inside either process — which is exactly why
        // `connect` could not be taught to make one by adding a flag. Different parent,
        // different collection, and no incoming/outgoing bookkeeping: node adjacency
        // lists hold sequence flows only.
        const from = byId.get(op.from), to = byId.get(op.to);
        if (!from) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `source "${op.from}" not found`);
        if (!to) throw new TherbligError('THB_NOT_FOUND_ELEMENT', `target "${op.to}" not found`);
        const collab = [...walk(definitions)].find((e) => e.$type === 'bpmn:Collaboration');
        if (!collab) {
          throw new TherbligError('THB_UNKNOWN_TYPE',
            'this file has no collaboration, so it has no pools for a message flow to cross');
        }
        const id = op.id && !byId.has(op.id) ? op.id : mintId(byId, `Message_${op.from}_${op.to}`);
        const mf = moddle.create('bpmn:MessageFlow', {
          id, sourceRef: from, targetRef: to, ...(op.name ? { name: op.name } : {}),
        });
        mf.$parent = collab;
        (collab.messageFlows ??= []).push(mf);
        byId.set(id, mf);
        changed.add(id);
        created.push(id);
        break;
      }
      default:
        throw new TherbligError('THB_UNKNOWN_TYPE', `unknown op "${op.op}"`);
    }
  }
  // Semantics and diagram are one document. `del` used to remove the element and
  // leave its BPMNShape on the plane pointing at nothing — a file that still parses,
  // still validates against the XSD, and that diCoverage called 100% covered because
  // it only ever asked elements->DI. Pruning here rather than in the `del` branch
  // makes it structural: no op can leave orphaned DI behind, present or future.
  // See FINDINGS.md F12 (D3).
  const prunedDI = pruneDI(definitions);
  return { changed: [...changed], created, prunedDI };
}

/**
 * Drop DI whose bpmnElement no longer exists in the tree.
 * Lives here rather than in place.mjs because place.mjs imports from this module,
 * and the reverse would be a cycle.
 */
export function pruneDI(definitions) {
  const live = index(definitions);
  const removed = [];
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmndi:BPMNPlane' || !el.planeElement) continue;
    for (let i = el.planeElement.length - 1; i >= 0; i--) {
      const target = el.planeElement[i].bpmnElement;
      const targetId = typeof target === 'string' ? target : target?.id;
      if (targetId && !live.has(targetId)) {
        el.planeElement.splice(i, 1);
        removed.push(targetId);
      }
    }
  }
  return removed;
}
