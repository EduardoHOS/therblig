// Parsing, serialization and tree traversal. The moddle tree is the source of truth
// (ADR-001); everything else in this package reads or mutates it.
import { BpmnModdle } from 'bpmn-moddle';

export async function parse(xml) {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  return { moddle, definitions: rootElement };
}

export async function serialize({ moddle, definitions }) {
  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

export function* walk(el, seen = new Set()) {
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
export function containerOf(el) {
  let p = el.$parent;
  while (p && !/^bpmn:(Process|SubProcess|Transaction|AdHocSubProcess)$/.test(p.$type)) p = p.$parent;
  return p?.id ?? null;
}

