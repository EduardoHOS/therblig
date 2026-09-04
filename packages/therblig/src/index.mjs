// Public surface of the therblig library.
//
// The moddle tree is the source of truth (ADR-001). `parse` gives you one, `project`
// gives a model a compact view of it, `applyPatch` mutates it through the only four
// operations that exist, `placeNew` gives new elements DI without disturbing what is
// already laid out, and `serialize` writes it back.
export { parse, serialize, walk, index, containerOf } from './model.mjs';
export { project, TYPE_MAP, REVERSE, EVENT_DEF } from './ir.mjs';
export { applyPatch, pruneDI } from './patch.mjs';
export { placeNew, diCoverage } from './place.mjs';
