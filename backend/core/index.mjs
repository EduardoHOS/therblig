/**
 * The backend core's public surface. Types are re-declared here so a consumer imports everything
 * from one place, the way a published package is used.
 *
 * @typedef {import('./ops.mjs').Envelope} Envelope
 * @typedef {import('./ops.mjs').RiskLevel} RiskLevel
 * @typedef {import('./ops.mjs').Step} Step
 * @typedef {import('./patch.mjs').Operation} Operation
 * @typedef {import('./patch.mjs').PatchResult} PatchResult
 * @typedef {import('./projection.mjs').Projection} Projection
 * @typedef {import('./projection.mjs').IrNode} IrNode
 * @typedef {import('./projection.mjs').IrFlow} IrFlow
 * @typedef {import('./propose.mjs').Proposal} Proposal
 */

export { linkFlow, retarget, unlinkFlow } from './adjacency.mjs';
export { contained, containerOf, index, parse, serialize, walk } from './document.mjs';
export { diffSanity, fingerprint, lintClean, parses, references, scoreAll, xsdValid } from './gates.mjs';
export {
  branch,
  bypass,
  guard,
  insertAfter,
  message,
  moveToLane,
  onError,
  parallel,
  rename,
  risk,
  timeout,
} from './ops.mjs';
export { applyPatch } from './patch.mjs';
export { propose } from './propose.mjs';
export { placeNew, diCoverage } from './placement.mjs';
export { project } from './projection.mjs';
export { block, blocks, byBpmn, byIr, tabulate } from './registry.mjs';
