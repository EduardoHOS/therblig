// inspect(xml) -> Diagnostic[]
//
// Static, unary: everything knowable from one file, without a "before" to compare to.
// This is the half of the oracle that answers "is this document sound", and it covers
// exactly what F7 named as the XSD gate's ceiling — BPMN cross-references are mostly
// xsd:QName, which no schema validator resolves, so dangling refs, cross-pool flows
// and duplicate ids all validate cleanly and are all wrong.
//
// Written against the validation set in the product brief, whose messages teach the
// rule rather than reporting a failure.
import { parse, walk, index } from '../../packages/therblig/src/model.mjs';
import { diCoverage } from '../../packages/therblig/src/place.mjs';
import { diag } from './invariants.mjs';

const FLOW_NODE = /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$/;
const GATEWAY = /^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$/;
const SPLITTING = /^bpmn:(Exclusive|Inclusive)Gateway$/;
const TASKLIKE = /Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:CallActivity$|^bpmn:Transaction$/;

const name = (el) => el?.name || el?.id || '(unnamed)';

// The outermost Process an element sits in — its pool, when there is a collaboration.
// containerOf() stops at the nearest SubProcess, which is right for scoping an edit
// and wrong for deciding whether a flow crosses a pool boundary.
function poolProcessOf(el) {
  let p = el?.$parent, last = null;
  while (p) {
    if (p.$type === 'bpmn:Process') last = p;
    p = p.$parent;
  }
  return last;
}

// True only when the file actually declares pools. A single-process file has no pool
// boundaries to cross, so the cross-pool rules must not fire on it.
function poolsDeclared(definitions) {
  for (const el of walk(definitions)) if (el.$type === 'bpmn:Participant') return true;
  return false;
}

// A node that is legitimately reached without an incoming sequence flow.
//
// The walk starts at the element ITSELF, not at its parent. An event sub-process is
// triggered by its own start event and has no incoming or outgoing flow by design, so
// checking only ancestors reported both of C.9.0's event sub-processes as unreachable —
// two false positives on the first run. A validator that cries wolf is worse than no
// validator, because the fix for noise is to stop reading the output.
const hasEventDef = (el, kind) =>
  (el.eventDefinitions || []).some((d) => d.$type === `bpmn:${kind}EventDefinition`);

function reachedWithoutFlow(el) {
  if (el.$type === 'bpmn:StartEvent') return true;
  if (el.$type === 'bpmn:BoundaryEvent') return true;
  // A link catch event is BPMN's goto target: it is reached by a matching link throw,
  // never by a sequence flow. B.2.0's "Intermediate Event Link" was a false positive.
  if (hasEventDef(el, 'Link')) return true;
  // A compensation activity is reached by a compensation association from a boundary
  // event, not by a sequence flow. C.6.0's "Cancel Hotel" and "Cancel Flight" were too.
  if (el.isForCompensation) return true;
  let p = el;
  while (p) {
    if (p.triggeredByEvent) return true;
    p = p.$parent;
  }
  return false;
}

// The same exemptions for termination: an event sub-process, a compensation handler
// and a link throw all legitimately have nowhere to flow onward.
function terminatesWithoutFlow(el) {
  if (el.isForCompensation) return true;
  if (hasEventDef(el, 'Link')) return true;
  let p = el;
  while (p) {
    if (p.triggeredByEvent) return true;
    p = p.$parent;
  }
  return false;
}

// A process that is not drawn on any plane needs no DI. B.1.0 and B.2.0 each carry a
// small process referenced by a call activity and never rendered; requiring shapes for
// it produced five false positives per file. Any process with at least one shape is
// considered drawn, and then every element in it is expected to have one.
function drawnProcessIds(definitions, byElementDI) {
  const drawn = new Set();
  for (const el of walk(definitions)) {
    if (!el.id || !byElementDI.has(el.id)) continue;
    const proc = poolProcessOf(el) ?? (el.$type === 'bpmn:Process' ? el : null);
    if (proc?.id) drawn.add(proc.id);
  }
  return drawn;
}

export async function inspect(xml) {
  const { definitions } = await parse(xml);
  return inspectTree(definitions);
}

export function inspectTree(definitions) {
  const out = [];
  const byId = index(definitions);
  const hasPools = poolsDeclared(definitions);

  // --- duplicate ids ---------------------------------------------------------
  // index() keeps the last element per id, so it cannot see a collision. Count instead.
  //
  // BPMN-namespace elements only. C.8.0 carries <adonis:target id="VacationRequestProcess">
  // beside <bpmn:process id="VacationRequestProcess">; ids are unique per namespace, so a
  // vendor extension reusing the value is legal and reporting it was a false positive.
  const seen = new Map();
  for (const el of walk(definitions)) {
    if (!el.id || !el.$type?.startsWith('bpmn:')) continue;
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) out.push(diag('DUPLICATE_ID', `${n} elements share the id ${id}.`, [id]));
  }

  // --- dangling references ---------------------------------------------------
  const REFS = ['sourceRef', 'targetRef', 'attachedToRef', 'messageRef', 'default', 'processRef'];
  for (const el of walk(definitions)) {
    if (!el.$type?.startsWith('bpmn:')) continue;
    for (const k of REFS) {
      const v = el[k];
      if (!v) continue;
      // A resolved reference is an object. A string here means moddle could not
      // resolve the QName — the target is not in the file.
      if (typeof v === 'string' && !byId.has(v)) {
        out.push(diag('DANGLING_REF', `${el.$type.replace('bpmn:', '')} ${name(el)} points at ${v}, which is not in this file.`, [el.id]));
      }
    }
  }

  // --- F8's invariant, made checkable ----------------------------------------
  // Adjacency lives on the flow AND on each endpoint. moddle maintains only the flow
  // side, so a mutation that writes one and not the other produces a file that is
  // XSD-valid and structurally a lie.
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmn:SequenceFlow') continue;
    const src = el.sourceRef, tgt = el.targetRef;
    if (src && typeof src === 'object' && !(src.outgoing || []).includes(el)) {
      out.push(diag('ADJACENCY_DESYNC', `Flow ${name(el)} lists ${name(src)} as its source, but ${name(src)} does not list it as outgoing.`, [el.id, src.id]));
    }
    if (tgt && typeof tgt === 'object' && !(tgt.incoming || []).includes(el)) {
      out.push(diag('ADJACENCY_DESYNC', `Flow ${name(el)} lists ${name(tgt)} as its target, but ${name(tgt)} does not list it as incoming.`, [el.id, tgt.id]));
    }
  }

  // --- diagram interchange ---------------------------------------------------
  const cov = diCoverage(definitions);
  for (const o of cov.orphans) {
    out.push(diag('DI_ORPHAN', `A ${o.type.replace('bpmndi:BPMN', '').toLowerCase()} refers to ${o.id}, which is not in this file.`, [o.id]));
  }
  // Only meaningful on a file that has DI at all; a semantic-only file is not broken.
  if (cov.need > 0 && cov.covered > 0) {
    const hasDI = new Set();
    for (const el of walk(definitions)) {
      if ((el.$type === 'bpmndi:BPMNShape' || el.$type === 'bpmndi:BPMNEdge') && el.bpmnElement?.id) {
        hasDI.add(el.bpmnElement.id);
      }
    }
    const drawn = drawnProcessIds(definitions, hasDI);
    for (const m of cov.missing) {
      const el = byId.get(m.id);
      const proc = poolProcessOf(el);
      // Skip elements belonging to a process nothing draws.
      if (proc && !drawn.has(proc.id)) continue;
      out.push(diag('DI_MISSING', `${m.type.replace('bpmn:', '')} ${m.id} has no shape.`, [m.id]));
    }
  }

  // --- flow-node reachability and termination --------------------------------
  for (const el of walk(definitions)) {
    if (!FLOW_NODE.test(el.$type)) continue;
    const inc = (el.incoming || []).length;
    const outg = (el.outgoing || []).length;
    const kind = el.$type.replace('bpmn:', '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

    if (inc === 0 && !reachedWithoutFlow(el)) {
      out.push(diag('UNREACHABLE', `1 ${kind} unreachable: ${name(el)}.`, [el.id]));
    }
    if (outg === 0 && el.$type !== 'bpmn:EndEvent' && TASKLIKE.test(el.$type) && !terminatesWithoutFlow(el)) {
      out.push(diag('NO_OUTGOING_FLOW', `${name(el)} has no outgoing flow.`, [el.id]));
    }
    if (GATEWAY.test(el.$type) && inc <= 1 && outg <= 1) {
      out.push(diag('GATEWAY_ARITY', `Gateway ${name(el)} has ${outg} outgoing flow.`, [el.id]));
    }
  }

  // --- pool-level rules ------------------------------------------------------
  for (const proc of walk(definitions)) {
    if (proc.$type !== 'bpmn:Process') continue;
    const children = proc.flowElements || [];
    const starts = children.filter((c) => c.$type === 'bpmn:StartEvent' && !c.$parent?.triggeredByEvent);
    const ends = children.filter((c) => c.$type === 'bpmn:EndEvent');
    const tasks = children.filter((c) => TASKLIKE.test(c.$type));
    if (starts.length > 1) {
      out.push(diag('MULTIPLE_START_EVENTS', `Pool ${name(proc)} has ${starts.length} start events.`, starts.map((s) => s.id)));
    }
    if (tasks.length > 0 && ends.length === 0) {
      out.push(diag('NO_END_EVENT', `Pool ${name(proc)} has no end event.`, [proc.id]));
    }
  }

  // --- lanes -----------------------------------------------------------------
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmn:Lane') continue;
    if ((el.flowNodeRef || []).length === 0) {
      out.push(diag('EMPTY_LANE', `Lane ${name(el)} has 0 tasks.`, [el.id]));
    }
  }

  // --- flow-kind rules, only where pools exist -------------------------------
  if (hasPools) {
    for (const el of walk(definitions)) {
      const src = el.sourceRef, tgt = el.targetRef;
      if (!src || !tgt || typeof src === 'string' || typeof tgt === 'string') continue;
      const sp = poolProcessOf(src), tp = poolProcessOf(tgt);
      if (!sp || !tp) continue;
      if (el.$type === 'bpmn:SequenceFlow' && sp !== tp) {
        out.push(diag('CROSS_POOL_SEQUENCE_FLOW', `Sequence flow ${name(src)} → ${name(tgt)} crosses pools.`, [el.id]));
      }
      if (el.$type === 'bpmn:MessageFlow' && sp === tp) {
        out.push(diag('INTRA_POOL_MESSAGE_FLOW', `Message flow ${name(src)} → ${name(tgt)} stays in one pool.`, [el.id]));
      }
    }
  }

  // --- gateway branches need conditions --------------------------------------
  for (const el of walk(definitions)) {
    if (!SPLITTING.test(el.$type)) continue;
    const outs = el.outgoing || [];
    if (outs.length < 2) continue;                       // GATEWAY_ARITY covers that
    for (const f of outs) {
      if (el.default && el.default === f) continue;      // the default branch needs none
      if (f.name || f.conditionExpression) continue;
      out.push(diag('UNLABELLED_BRANCH', `Flow ${name(el)} → ${name(f.targetRef)} has no label.`, [f.id]));
    }
  }

  return out;
}
