import * as activities from './blocks/activities.mjs';
import * as events from './blocks/events.mjs';
import * as gateways from './blocks/gateways.mjs';

// The three families the notation draws: a circle, a rounded box, a diamond. A block that claimed
// a fourth would have no shape to be drawn as.
const ROLES = new Set(['event', 'activity', 'gateway']);

/** The mark an event wears comes from its kind, not its block: one StartEvent, ten possible marks. */
export const eventGlyphs = events.EVENT_GLYPH_BY_KIND;

// One definition per BPMN element type, consumed by projection, patch and placement alike. The
// keys of this table are the closed node vocabulary: what is not here cannot be added or named.
export const blocks = Object.freeze(
  [events, activities, gateways].flatMap((module) =>
    Object.values(module).filter((value) => value?.bpmn && value?.ir),
  ),
);

// Validation runs at import, not at the first patch: a malformed block is a build error.
export function tabulate(candidates) {
  const byBpmn = new Map();
  const byIr = new Map();

  for (const candidate of candidates) {
    const { bpmn, ir, shape, role, glyph } = candidate;
    if (typeof bpmn !== 'string' || !bpmn.startsWith('bpmn:')) {
      throw new Error(`Block "${ir}" has no BPMN type`);
    }
    if (typeof ir !== 'string' || !ir) throw new Error(`Block "${bpmn}" has no IR word`);
    if (!(shape?.w > 0) || !(shape?.h > 0)) throw new Error(`Block "${ir}" has no positive shape`);
    if (!ROLES.has(role)) throw new Error(`Block "${ir}" has no drawable role`);
    // An event's mark comes from its kind. An activity has to have decided, and `null` is a
    // decision: a plain task and a call activity both wear nothing, for different reasons. A
    // gateway has no such option — without its mark it is the same diamond as the other four.
    if (role === 'activity' && typeof glyph !== 'string' && glyph !== null) {
      throw new Error(`Block "${ir}" declares no glyph`);
    }
    if (role === 'gateway' && typeof glyph !== 'string') {
      throw new Error(`Gateway "${ir}" has no mark to tell it from the others`);
    }
    if (byIr.has(ir)) throw new Error(`Duplicate IR word "${ir}"`);

    for (const type of [bpmn, ...(candidate.also ?? [])]) {
      if (byBpmn.has(type)) throw new Error(`Duplicate BPMN type "${type}"`);
      byBpmn.set(type, candidate);
    }
    byIr.set(ir, candidate);
  }

  return { byBpmn, byIr };
}

export const { byBpmn, byIr } = tabulate(blocks);

export function block(ir) {
  const found = byIr.get(ir);
  if (!found) throw new Error(`Unknown node type "${ir}"`);
  return found;
}
