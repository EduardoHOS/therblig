// The five event blocks. Event kinds (timer, message, error, …) are modifiers of these five and
// not blocks of their own: the same StartEvent is a plain start or a message start depending on
// its eventDefinitions, so a kind never needs its own shape, ports, or build.

export const EVENT_KIND_BY_BPMN = new Map([
  ['bpmn:MessageEventDefinition', 'message'],
  ['bpmn:TimerEventDefinition', 'timer'],
  ['bpmn:ErrorEventDefinition', 'error'],
  ['bpmn:SignalEventDefinition', 'signal'],
  ['bpmn:EscalationEventDefinition', 'escalation'],
  ['bpmn:TerminateEventDefinition', 'terminate'],
  ['bpmn:ConditionalEventDefinition', 'conditional'],
  ['bpmn:CompensateEventDefinition', 'compensate'],
  ['bpmn:LinkEventDefinition', 'link'],
  ['bpmn:CancelEventDefinition', 'cancel'],
]);

export const BPMN_EVENT_BY_KIND = new Map(
  [...EVENT_KIND_BY_BPMN].map(([bpmnType, eventKind]) => [eventKind, bpmnType]),
);

/**
 * The mark BPMN puts inside an event, drawn here rather than taken from a library: this is the
 * notation vocabulary, and it belongs with the blocks that own the types.
 *
 * Every glyph is authored in a 16×16 box with its origin at the top left. It carries no colour and
 * no stroke width — the renderer wraps it in a `<g>` that supplies both, and fills the group when
 * the event throws rather than catches. A shape that must stay a line even inside a filled event
 * says `fill="none"` for itself.
 */
export const EVENT_GLYPH_BY_KIND = new Map([
  ['message', '<path d="M1.5,4.5 h13 v7 h-13 z"/><path d="M1.5,4.5 L8,9.5 L14.5,4.5" fill="none"/>'],
  ['timer', '<circle cx="8" cy="8" r="6.5" fill="none"/><path d="M8,4 V8 L10.5,10" fill="none"/>'],
  ['error', '<path d="M2,14 L6,5.5 L9.5,10 L14,2 L10,10.5 L6.5,6 z"/>'],
  ['signal', '<path d="M8,2 L14.5,13 H1.5 z"/>'],
  ['escalation', '<path d="M8,2 L13.5,14 L8,9 L2.5,14 z"/>'],
  ['terminate', '<circle cx="8" cy="8" r="6.5"/>'],
  ['conditional', '<path d="M3,2 h10 v12 h-10 z" fill="none"/><path d="M5,5.5 h6 M5,8 h6 M5,10.5 h4" fill="none"/>'],
  ['compensate', '<path d="M7.5,3 V13 L1.5,8 z"/><path d="M14.5,3 V13 L8.5,8 z"/>'],
  ['link', '<path d="M2,6 h7 V3.5 L14.5,8 L9,12.5 V10 H2 z"/>'],
  ['cancel', '<path d="M3.5,2.5 L8,7 L12.5,2.5 L13.5,3.5 L9,8 L13.5,12.5 L12.5,13.5 L8,9 L3.5,13.5 L2.5,12.5 L7,8 L2.5,3.5 z"/>'],
]);

const TIMER_PROPERTY = { duration: 'timeDuration', cycle: 'timeCycle', date: 'timeDate' };
const SHAPE = { w: 36, h: 36 };

function projectKinds(element) {
  const kinds = (element.eventDefinitions || [])
    .map((definition) => EVENT_KIND_BY_BPMN.get(definition.$type) || definition.$type)
    .filter(Boolean);
  if (!kinds.length) return {};
  return { event: kinds.length === 1 ? kinds[0] : kinds };
}

function buildKinds(element, operation, { moddle }) {
  if (operation.event) {
    const definitionType = BPMN_EVENT_BY_KIND.get(operation.event);
    if (!definitionType) throw new Error(`Unknown event kind "${operation.event}"`);
    const definition = moddle.create(definitionType, {});
    definition.$parent = element;
    element.eventDefinitions = [definition];
  }
  if (!operation.timer) return;

  if (operation.event !== 'timer') throw new Error('Timer requires event "timer"');
  const given = Object.keys(TIMER_PROPERTY).filter((key) => operation.timer[key] != null);
  if (given.length !== 1) throw new Error('Timer requires exactly one of duration, cycle, or date');
  const [definition] = element.eventDefinitions;
  const expression = moddle.create('bpmn:FormalExpression', { body: operation.timer[given[0]] });
  expression.$parent = definition;
  definition[TIMER_PROPERTY[given[0]]] = expression;
}

/**
 * An event throws or it catches, and its ring says where in the process it sits. Both are notation,
 * and both live here with the blocks that own the types:
 *
 * - `ring` — `thin` starts, `double` happens along the way, `thick` ends. This is how a reader tells
 *   a start event from an intermediate one when neither carries a kind.
 * - `throwing` — fills the mark. The difference between "this happened" and "this is being waited
 *   for" is a filled glyph and nothing else.
 */
const event = (bpmn, ir, ring, throwing = false) =>
  Object.freeze({
    bpmn,
    ir,
    role: 'event',
    ring,
    shape: SHAPE,
    ...(throwing ? { throwing: true } : {}),
    project: projectKinds,
    build: buildKinds,
  });

export const start = event('bpmn:StartEvent', 'start', 'thin');
export const end = event('bpmn:EndEvent', 'end', 'thick', true);
export const catchEvent = event('bpmn:IntermediateCatchEvent', 'catch', 'double');
export const throwEvent = event('bpmn:IntermediateThrowEvent', 'throw', 'double', true);

export const boundary = Object.freeze({
  bpmn: 'bpmn:BoundaryEvent',
  ir: 'boundary',
  role: 'event',
  ring: 'double',
  shape: SHAPE,
  project(element) {
    return {
      ...(element.attachedToRef?.id ? { on: element.attachedToRef.id } : {}),
      ...projectKinds(element),
      ...(element.cancelActivity === false ? { interrupting: false } : {}),
    };
  },
  build(element, operation, context) {
    buildKinds(element, operation, context);
    if (!operation.on) return;

    const host = context.byId.get(operation.on);
    if (!host) throw new Error(`Boundary host "${operation.on}" not found`);
    element.attachedToRef = host;
    if (operation.interrupting === false) element.cancelActivity = false;
  },
});
