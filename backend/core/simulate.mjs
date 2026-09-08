import { project } from './projection.mjs';
import { walk } from './document.mjs';

/**
 * A discrete-event token machine over the IR. Every token carries its own clock, so a node fires
 * at the latest arrival among the tokens it consumes and a parallel join takes the longer branch
 * rather than the sum of both.
 *
 * It runs the subset whose semantics are decidable from information local to a node, and refuses
 * the rest by name. A number that quietly guessed at an inclusive join would be worse than none.
 *
 * @typedef {object} Summary
 * @property {number | null} p50            seconds; null when anything was refused or deadlocked
 * @property {number | null} p90
 * @property {boolean} synthetic            true when no duration in the model was annotated
 * @property {Record<string, number>} visits
 * @property {string[]} unsupported         ids this machine will not pretend to run
 * @property {string[]} undecided           gateways the scenario did not decide
 * @property {number} deadlocks
 * @property {number} unbounded             runs that hit the step budget, most often a loop
 * @property {number} runs
 */

// Refused by name, with the reason: each needs information no node carries on its own. An
// inclusive join must know which branches upstream actually fired; compensation must know what
// already completed; multi-instance must know a collection size the model does not state.
const UNSUPPORTED = {
  or: 'an inclusive join needs to know which upstream branches fired',
  complex: 'a complex gateway has no defined semantics to run',
};
// A subprocess or a call activity is run as one opaque step: entering its scope is a separate
// piece of work, and pretending otherwise would report a cycle time that skipped its contents.
const DEFAULT_SECONDS = 3600;

// Deterministic, so a test can assert an exact number rather than an interval.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ISO-8601 durations, the subset a process actually uses. Anything else is not a duration.
const ISO = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
export function seconds(duration) {
  const match = ISO.exec(duration ?? '');
  if (!match) return null;
  const parts = match.slice(1, 5);
  if (parts.every((part) => part === undefined)) return null;
  const [days, hours, minutes, secs] = parts.map((part) => Number(part ?? 0));
  return days * 86400 + hours * 3600 + minutes * 60 + secs;
}

// Durations live in the file, in our own namespace, so they are versioned with the process and
// survive every other tool: moddle round-trips an unknown extension element untouched.
function durationsOf(definitions) {
  const byId = new Map();
  for (const element of walk(definitions)) {
    for (const value of element.extensionElements?.values ?? []) {
      if (value.$type !== 'treadle:duration') continue;
      const parsed = seconds(value.p50);
      if (parsed !== null) byId.set(element.id, parsed);
    }
  }
  return byId;
}

function graphOf(all, flows) {
  const nodes = new Map(all.map((node) => [node.id, node]));
  const out = new Map();
  const into = new Map();
  for (const flow of flows) {
    out.set(flow.from, [...(out.get(flow.from) ?? []), flow]);
    into.set(flow.to, [...(into.get(flow.to) ?? []), flow]);
  }
  const empty = [];
  const edges = (map, id) => map.get(id) ?? empty;
  return {
    node: (id) => nodes.get(id),
    out: (id) => edges(out, id),
    into: (id) => edges(into, id),
    starts: () => all.filter((node) => node.type === 'start' && !into.has(node.id)),
  };
}

// Conditions are not evaluated — evaluating FEEL or JUEL would tie this to an engine. The caller
// says which paths are taken, keyed by a flow's condition, its id, or its label, as a boolean or
// a probability. Most real gateways carry only a label, so all three have to work.
const UNDECIDED = Symbol('undecided');

// A weight the scenario gives this flow, by whichever key the model carries: its condition, its
// id, or its label. `true` and `false` are weights of 1 and 0, so a boolean stays exact.
function weightOf(when, flow) {
  for (const key of [flow.if, flow.id, flow.name]) {
    if (key === undefined || !(key in when)) continue;
    const value = when[key];
    return typeof value === 'number' ? value : Number(value === true);
  }
  return null;
}

function fire(node, graph, when, rng) {
  const exits = graph.out(node.id);

  if (node.type === 'xor' || node.type === 'event_gw') {
    const weights = exits.map((flow) => weightOf(when, flow));
    const given = weights.filter((weight) => weight !== null);

    if (given.length) {
      // Weights the scenario left out share whatever probability is unspoken for, so naming one
      // path at 0.25 means the others take the remaining 0.75 between them. When every path is
      // named, the weights are normalised as given.
      const named = given.reduce((sum, weight) => sum + weight, 0);
      const silent = weights.length - given.length;
      const share = silent && named < 1 ? (1 - named) / silent : 0;
      const effective = weights.map((weight) => weight ?? share);
      const total = effective.reduce((sum, weight) => sum + weight, 0);

      if (total > 0) {
        let draw = rng() * total;
        let index = 0;
        while (index < exits.length - 1 && (draw -= effective[index]) >= 0) index++;
        return [exits[index]];
      }
      // Every way out was ruled out by name. That is a halt, and the model deserves to hear it.
      return null;
    }

    const fallback = exits.find((flow) => flow.id === node.default);
    if (fallback) return [fallback];
    if (exits.length === 1) return exits;
    // Two ways out and nothing to choose between them. Taking the first would be a number
    // invented by iteration order, so the run says what it needed instead.
    return exits.length ? UNDECIDED : null;
  }
  // Everything else sends a token down every exit: a parallel split by definition, and an
  // activity with two exits by BPMN's own implicit-split rule.
  return exits;
}

export function simulate(definitions, { runs = 200, seed = 1, when = {} } = {}) {
  const ir = project(definitions);
  const nodes = ir.nodes ?? [];
  const graph = graphOf(nodes, ir.flows ?? []);
  const annotated = durationsOf(definitions);

  const refused = new Set();
  for (const node of nodes) {
    const reason = UNSUPPORTED[node.type];
    if (reason && graph.into(node.id).length > 1) refused.add(node.id);
  }

  const visits = {};
  const cycles = [];
  const budget = Math.max(200, nodes.length * 50);
  const undecidable = new Set();
  let deadlocks = 0;
  let unbounded = 0;

  for (let run = 0; run < runs && !refused.size; run++) {
    const rng = mulberry32(seed + run);
    const tokens = [];
    const ends = [];
    for (const start of graph.starts()) {
      for (const exit of graph.out(start.id)) tokens.push({ edge: exit.id, to: exit.to, t: 0 });
      visits[start.id] = (visits[start.id] ?? 0) + 1;
    }

    let halted = false;
    let ran = false;
    let steps = 0;
    while (tokens.length && !halted) {
      if (++steps > budget) {
        ran = true;
        break;
      }
      // A node fires when every edge it waits on holds a token: one for anything else, all of
      // them for a parallel join. That check is what makes the join wait.
      const ready = tokens.find((token) => {
        const node = graph.node(token.to);
        if (!node) return false;
        const waits = node.type === 'and' ? graph.into(node.id) : [];
        return waits.every((flow) => tokens.some((other) => other.edge === flow.id));
      });
      if (!ready) {
        halted = true;
        break;
      }

      const node = graph.node(ready.to);
      const waits = node.type === 'and' ? graph.into(node.id).map((flow) => flow.id) : [ready.edge];
      const consumed = waits.map((edge) => tokens.find((token) => token.edge === edge));
      for (const token of consumed) tokens.splice(tokens.indexOf(token), 1);

      const at = Math.max(...consumed.map((token) => token.t));
      visits[node.id] = (visits[node.id] ?? 0) + 1;

      if (node.type === 'end') {
        ends.push(at);
        if (node.event === 'terminate') break;
        continue;
      }

      const next = fire(node, graph, when, rng);
      if (next === UNDECIDED) {
        undecidable.add(node.id);
        halted = true;
        break;
      }
      if (!next || !next.length) {
        halted = true;
        break;
      }
      const spent = at + durationFor(node, annotated);
      for (const exit of next) tokens.push({ edge: exit.id, to: exit.to, t: spent });
    }

    if (ran) unbounded++;
    else if (halted || !ends.length) deadlocks++;
    else cycles.push(Math.max(...ends));
  }

  cycles.sort((a, b) => a - b);
  const quantile = (q) => cycles[Math.min(cycles.length - 1, Math.floor(q * cycles.length))];
  const clean =
    !refused.size && !undecidable.size && deadlocks === 0 && unbounded === 0 && cycles.length > 0;

  return {
    p50: clean ? quantile(0.5) : null,
    p90: clean ? quantile(0.9) : null,
    // Said out loud: without an annotated duration every number here is invented, and a p50 with
    // decimal places on invented input is opinion dressed as measurement.
    synthetic: annotated.size === 0,
    visits,
    unsupported: [...refused],
    // Gateways the scenario did not decide. Not a defect in the model — a question for the caller.
    undecided: [...undecidable],
    deadlocks,
    // Runs that hit the step budget: a loop this machine cannot bound, reported rather than hung.
    unbounded,
    runs,
  };
}

// An activity with no annotation still has to take some time, or every branch finishes at once
// and a parallel join proves nothing. A gateway takes none: it decides, it does not work.
const INSTANT = new Set(['start', 'end', 'xor', 'and', 'or', 'event_gw', 'complex', 'boundary']);

function durationFor(node, annotated) {
  if (annotated.has(node.id)) return annotated.get(node.id);
  return INSTANT.has(node.type) ? 0 : DEFAULT_SECONDS;
}
