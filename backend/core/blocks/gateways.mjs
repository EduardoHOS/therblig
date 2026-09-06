// Gateway blocks. They differ from each other only in routing semantics, which lives in `check`
// and `token` — neither exists yet, so today a gateway is its type, its diamond, and its default.

import { projectDefault } from './activities.mjs';

const SHAPE = { w: 50, h: 50 };

const gateway = (bpmn, ir) => Object.freeze({ bpmn, ir, shape: SHAPE, project: projectDefault });

export const xor = gateway('bpmn:ExclusiveGateway', 'xor');
export const and = gateway('bpmn:ParallelGateway', 'and');
export const or = gateway('bpmn:InclusiveGateway', 'or');
export const eventGateway = gateway('bpmn:EventBasedGateway', 'event_gw');
export const complex = gateway('bpmn:ComplexGateway', 'complex');
