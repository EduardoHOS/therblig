// The gates live in the core: `propose` cannot publish a document it has not scored, and the core
// may not import bench/. The bake-off scores every arm with exactly this code.
export {
  boundsList,
  diffSanity,
  fingerprint,
  lintClean,
  noCollateral,
  parses,
  references,
  scoreAll,
  semantics,
  xsdValid,
} from '../../backend/core/gates.mjs';
