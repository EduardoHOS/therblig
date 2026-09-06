import { project } from './projection.mjs';

/**
 * Replay an explicit trace against a model: does what happened match what the model says may
 * happen, and what does the model allow that never happens?
 *
 * A trace is a list of element ids in the order they ran. It is not a log — turning a log into
 * one means matching case ids and activity names to elements, which is a different problem and
 * belongs to the layer that binds a step to the system that performs it.
 *
 * @typedef {object} Conformance
 * @property {boolean} ok
 * @property {{at: number, id: string, after: string | null, reason: string} | null} diverged
 * @property {string[]} unvisited   nodes the model allows that this trace never reached
 * @property {string[]} unknown     ids in the trace that are not in the model at all
 */
export function conform(definitions, trace) {
  const ir = project(definitions);
  const all = ir.nodes ?? [];
  const flows = ir.flows ?? [];
  const nodes = new Map(all.map((node) => [node.id, node]));

  const unknown = trace.filter((id) => !nodes.has(id));
  const canFollow = (from, to) =>
    flows.some((flow) => flow.from === from && flow.to === to) ||
    // A boundary event fires from its host rather than along a flow, and its host is what ran.
    nodes.get(to)?.on === from;

  let diverged = null;
  for (const [at, id] of trace.entries()) {
    if (!nodes.has(id)) {
      diverged = { at, id, after: trace[at - 1] ?? null, reason: 'not an element of this model' };
      break;
    }
    if (at === 0) {
      // Something has to be able to start. A start event can, and so can anything with no way in.
      const node = nodes.get(id);
      const reachable = node.type === 'start' || !flows.some((flow) => flow.to === id);
      if (!reachable) {
        diverged = { at, id, after: null, reason: 'the model does not start here' };
        break;
      }
      continue;
    }
    if (!canFollow(trace[at - 1], id)) {
      diverged = { at, id, after: trace[at - 1], reason: 'no path leads here from the step before' };
      break;
    }
  }

  const visited = new Set(trace);
  return {
    ok: diverged === null,
    diverged,
    // The question worth asking of a real process: which of the paths we drew does nobody take?
    unvisited: all.filter((node) => !visited.has(node.id)).map((node) => node.id),
    unknown,
  };
}
