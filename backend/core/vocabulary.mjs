export const NODE_TYPE_BY_BPMN = new Map([
  ['bpmn:StartEvent', 'start'],
  ['bpmn:EndEvent', 'end'],
  ['bpmn:IntermediateCatchEvent', 'catch'],
  ['bpmn:IntermediateThrowEvent', 'throw'],
  ['bpmn:BoundaryEvent', 'boundary'],
  ['bpmn:Task', 'task'],
  ['bpmn:UserTask', 'user'],
  ['bpmn:ServiceTask', 'service'],
  ['bpmn:SendTask', 'send'],
  ['bpmn:ReceiveTask', 'receive'],
  ['bpmn:ManualTask', 'manual'],
  ['bpmn:ScriptTask', 'script'],
  ['bpmn:BusinessRuleTask', 'rule'],
  ['bpmn:SubProcess', 'subprocess'],
  ['bpmn:CallActivity', 'call'],
  ['bpmn:Transaction', 'subprocess'],
  ['bpmn:ExclusiveGateway', 'xor'],
  ['bpmn:ParallelGateway', 'and'],
  ['bpmn:InclusiveGateway', 'or'],
  ['bpmn:EventBasedGateway', 'event_gw'],
  ['bpmn:ComplexGateway', 'complex'],
]);

export const BPMN_TYPE_BY_NODE = new Map(
  [...NODE_TYPE_BY_BPMN].map(([bpmnType, nodeType]) => [nodeType, bpmnType]),
);
BPMN_TYPE_BY_NODE.set('subprocess', 'bpmn:SubProcess');

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
