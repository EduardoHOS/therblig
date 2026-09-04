// The IR: a compact, lossy READ-projection of the moddle tree for a model to reason
// over. It is never stored and never round-trips — patches apply to the tree, and the
// tree is what gets serialized. See ADR-001.
import { walk, containerOf } from './model.mjs';

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

export { TYPE_MAP, REVERSE, EVENT_DEF };

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
