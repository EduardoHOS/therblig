// Activity blocks. `default` is a BPMN property of activities and gateways alike, so both
// families project it; nothing else here differs between a user task and a script task.

const SHAPE = { w: 100, h: 80 };
const CONTAINER_SHAPE = { w: 350, h: 200 };

export function projectDefault(element) {
  return element.default?.id ? { default: element.default.id } : {};
}

const activity = (bpmn, ir) => Object.freeze({ bpmn, ir, shape: SHAPE, project: projectDefault });

export const task = activity('bpmn:Task', 'task');
export const user = activity('bpmn:UserTask', 'user');
export const service = activity('bpmn:ServiceTask', 'service');
export const send = activity('bpmn:SendTask', 'send');
export const receive = activity('bpmn:ReceiveTask', 'receive');
export const manual = activity('bpmn:ManualTask', 'manual');
export const script = activity('bpmn:ScriptTask', 'script');
export const rule = activity('bpmn:BusinessRuleTask', 'rule');
export const call = activity('bpmn:CallActivity', 'call');

export const subprocess = Object.freeze({
  bpmn: 'bpmn:SubProcess',
  // A Transaction is a SubProcess with transactional boundaries: it reads as one and is sized as
  // one, but `add subprocess` mints the plain form because that is what a caller asking for a
  // subprocess means.
  also: ['bpmn:Transaction'],
  ir: 'subprocess',
  shape: CONTAINER_SHAPE,
  project(element) {
    return {
      ...projectDefault(element),
      ...(element.triggeredByEvent ? { eventSubprocess: true } : {}),
    };
  },
});
