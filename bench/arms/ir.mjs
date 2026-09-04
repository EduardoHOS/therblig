// Arm C's mechanism now lives in packages/therblig/src/. This shim keeps the bench
// harness importing the same names it always did, so the 51 assertions that were
// written against the prototype are the regression suite for the move itself.
//
// Split, for anyone following the imports:
//   model.mjs  parse · serialize · walk · index · containerOf
//   ir.mjs     project · TYPE_MAP · REVERSE · EVENT_DEF
//   patch.mjs  applyPatch · pruneDI · linkFlow/unlinkFlow/retarget
export { parse, serialize, walk, index, containerOf } from '../../packages/therblig/src/model.mjs';
export { project, TYPE_MAP, REVERSE, EVENT_DEF } from '../../packages/therblig/src/ir.mjs';
export { applyPatch, pruneDI } from '../../packages/therblig/src/patch.mjs';
