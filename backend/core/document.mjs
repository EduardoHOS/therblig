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

export function* walk(element, seen = new Set()) {
  if (!element || typeof element !== 'object' || seen.has(element)) return;
  seen.add(element);
  yield element;

  for (const key of Object.keys(element)) {
    if (key === '$parent' || key === '$model' || key === '$descriptor') continue;
    const value = element[key];
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child, seen);
    } else if (value && typeof value === 'object') {
      yield* walk(value, seen);
    }
  }
}

// walk() follows every reference, which reaches the whole graph. Deleting an element removes what
// it *contains*, and containment is exactly `child.$parent === element`.
export function* contained(element) {
  yield element;
  for (const key of Object.keys(element)) {
    if (key.startsWith('$')) continue;
    const value = element[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && child.$parent === element) yield* contained(child);
    }
  }
}

export function index(definitions) {
  const byId = new Map();
  for (const element of walk(definitions)) {
    // Generic vendor attributes named `id` need not be XML IDs. C.8.0 uses one as an
    // ADONIS reference to its process; indexing it would shadow the actual BPMN container.
    if (element.id && !element.$descriptor?.isGeneric) byId.set(element.id, element);
  }
  return byId;
}

export function containerOf(element) {
  let parent = element.$parent;
  while (
    parent &&
    !/^bpmn:(Process|SubProcess|Transaction|AdHocSubProcess)$/.test(parent.$type)
  ) {
    parent = parent.$parent;
  }
  return parent?.id ?? null;
}
