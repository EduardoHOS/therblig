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

const event = (bpmn, ir) =>
  Object.freeze({ bpmn, ir, shape: SHAPE, project: projectKinds, build: buildKinds });

export const start = event('bpmn:StartEvent', 'start');
export const end = event('bpmn:EndEvent', 'end');
export const catchEvent = event('bpmn:IntermediateCatchEvent', 'catch');
export const throwEvent = event('bpmn:IntermediateThrowEvent', 'throw');

export const boundary = Object.freeze({
  bpmn: 'bpmn:BoundaryEvent',
  ir: 'boundary',
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
