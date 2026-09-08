// Gateway blocks. They differ from each other only in routing semantics, which lives in `check`
// and `token` — neither exists yet, so today a gateway is its type, its diamond, and its default.

import { projectDefault } from './activities.mjs';

const SHAPE = { w: 50, h: 50 };

/**
 * What each diamond carries, drawn by us in a 16×16 box with its origin at the top left. The
 * renderer supplies colour and stroke width; a shape that must stay a line says `fill="none"`.
 *
 * The marks are the whole difference between the five: without them every gateway is the same
 * diamond, and a reader cannot tell a split from a merge from a race.
 */
const GLYPH = {
  xor: '<path d="M3.5,3.5 L12.5,12.5 M12.5,3.5 L3.5,12.5" fill="none"/>',
  and: '<path d="M8,2 V14 M2,8 H14" fill="none"/>',
  or: '<circle cx="8" cy="8" r="5.5" fill="none"/>',
  event_gw:
    '<circle cx="8" cy="8" r="7" fill="none"/><circle cx="8" cy="8" r="5.4" fill="none"/>' +
    '<path d="M8,3.8 L11.8,6.6 L10.3,11 H5.7 L4.2,6.6 z" fill="none"/>',
  complex: '<path d="M8,1.5 V14.5 M1.5,8 H14.5 M3.4,3.4 L12.6,12.6 M12.6,3.4 L3.4,12.6" fill="none"/>',
};

const gateway = (bpmn, ir) =>
  Object.freeze({ bpmn, ir, role: 'gateway', shape: SHAPE, glyph: GLYPH[ir], project: projectDefault });

export const xor = gateway('bpmn:ExclusiveGateway', 'xor');
export const and = gateway('bpmn:ParallelGateway', 'and');
export const or = gateway('bpmn:InclusiveGateway', 'or');
export const eventGateway = gateway('bpmn:EventBasedGateway', 'event_gw');
export const complex = gateway('bpmn:ComplexGateway', 'complex');
