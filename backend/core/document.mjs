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

export function index(definitions) {
  const byId = new Map();
  for (const element of walk(definitions)) {
    if (element.id) byId.set(element.id, element);
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
