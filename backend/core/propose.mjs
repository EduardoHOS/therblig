import { parse, serialize } from './document.mjs';
import { scoreAll } from './gates.mjs';
import { applyPatch } from './patch.mjs';
import { diCoverage, placeNew } from './placement.mjs';

// A proposal is a dry run. It applies the plan to an isolated copy of the document, places what
// it created, scores every gate, and returns the result — the caller's document is never touched,
// so a plan that fails halfway leaves nothing behind. There is no deep clone of a moddle tree, so
// serialize-then-parse is the clone.
export async function propose(document, operations) {
  const before = await serialize(document);
  const isolated = await parse(before);

  let result;
  try {
    result = applyPatch(isolated, operations);
  } catch (cause) {
    const error = new Error(
      `Operation ${cause.at + 1} of ${operations.length} failed: ${cause.message}`,
      { cause },
    );
    error.code = 'operation-failed';
    throw error;
  }

  const placement = placeNew(isolated, result.created);
  const coverage = diCoverage(isolated.definitions);
  const xml = await serialize(isolated);
  const { gates } = await scoreAll(before, xml, { expectChangedIds: result.changed });
  gates.diCoverage = coverage;

  return {
    ok: Object.values(gates).every((gate) => gate.ok),
    xml,
    gates,
    diff: gates.diffSanity,
    created: result.created,
    changed: result.changed,
    placed: placement.placed,
  };
}
