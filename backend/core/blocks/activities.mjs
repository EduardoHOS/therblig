// Activity blocks. `default` is a BPMN property of activities and gateways alike, so both
// families project it; nothing else here differs between a user task and a script task.

const SHAPE = { w: 100, h: 80 };
const CONTAINER_SHAPE = { w: 350, h: 200 };

/**
 * The mark BPMN puts in the top-left corner of an activity, drawn by us in a 16×16 box with its
 * origin at the top left. It carries no colour and no stroke width: the renderer supplies both, so
 * one vocabulary serves a light file and a dark page. A shape that must stay a line inside a filled
 * mark says `fill="none"` for itself.
 *
 * A plain task has no mark, and a call activity is marked by a thicker border rather than a glyph —
 * both are `null` here rather than absent, so a new block cannot forget to decide.
 */
const GLYPH = {
  user: '<circle cx="8" cy="4.6" r="2.6"/><path d="M2.6,14 C2.6,10.2 5,8.6 8,8.6 C11,8.6 13.4,10.2 13.4,14" fill="none"/>',
  service:
    '<circle cx="8" cy="8" r="3.4" fill="none"/><circle cx="8" cy="8" r="1.2"/>' +
    '<path d="M8,1.6 V4 M8,12 V14.4 M1.6,8 H4 M12,8 H14.4 M3.5,3.5 L5.2,5.2 M10.8,10.8 L12.5,12.5 M12.5,3.5 L10.8,5.2 M5.2,10.8 L3.5,12.5" fill="none"/>',
  send: '<path d="M1.5,4 h13 v8 h-13 z"/><path d="M1.5,4 L8,9.2 L14.5,4" fill="none"/>',
  receive: '<path d="M1.5,4 h13 v8 h-13 z" fill="none"/><path d="M1.5,4 L8,9.2 L14.5,4" fill="none"/>',
  manual:
    '<path d="M3,12.5 V7.6 a1.1,1.1 0 0 1 2.2,0 V4.4 a1.1,1.1 0 0 1 2.2,0 V4 a1.1,1.1 0 0 1 2.2,0 v0.8 ' +
    'a1.1,1.1 0 0 1 2.2,0 V11 a3.5,3.5 0 0 1 -3.5,3.5 H6 a3,3 0 0 1 -3,-2 z" fill="none"/>',
  script:
    '<path d="M4.5,2 h7.5 v12 h-7.5 z" fill="none"/><path d="M6.5,5.2 h3.5 M6.5,8 h3.5 M6.5,10.8 h2.5" fill="none"/>',
  rule: '<path d="M2,3 h12 v10 h-12 z" fill="none"/><path d="M2,6 h12 M6,6 V13" fill="none"/>',
  subprocess: '<path d="M2,2 h12 v12 h-12 z" fill="none"/><path d="M4.5,8 h7 M8,4.5 v7" fill="none"/>',
};

export function projectDefault(element) {
  return element.default?.id ? { default: element.default.id } : {};
}

const activity = (bpmn, ir, extra = {}) =>
  Object.freeze({ bpmn, ir, role: 'activity', shape: SHAPE, glyph: GLYPH[ir] ?? null, project: projectDefault, ...extra });

export const task = activity('bpmn:Task', 'task');
export const user = activity('bpmn:UserTask', 'user');
export const service = activity('bpmn:ServiceTask', 'service');
export const send = activity('bpmn:SendTask', 'send');
export const receive = activity('bpmn:ReceiveTask', 'receive');
export const manual = activity('bpmn:ManualTask', 'manual');
export const script = activity('bpmn:ScriptTask', 'script');
export const rule = activity('bpmn:BusinessRuleTask', 'rule');
// A call activity has no mark of its own: BPMN thickens its border instead, which is what says
// "the work is somewhere else".
export const call = activity('bpmn:CallActivity', 'call', { border: 3 });

export const subprocess = Object.freeze({
  bpmn: 'bpmn:SubProcess',
  // A Transaction is a SubProcess with transactional boundaries: it reads as one and is sized as
  // one, but `add subprocess` mints the plain form because that is what a caller asking for a
  // subprocess means.
  also: ['bpmn:Transaction'],
  ir: 'subprocess',
  role: 'activity',
  shape: CONTAINER_SHAPE,
  // Only when collapsed: an expanded subprocess shows its contents instead, and the renderer knows
  // which it is from the DI.
  glyph: GLYPH.subprocess,
  project(element) {
    return {
      ...projectDefault(element),
      ...(element.triggeredByEvent ? { eventSubprocess: true } : {}),
    };
  },
});
