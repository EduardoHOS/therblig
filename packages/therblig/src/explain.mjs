// explain(xml) — what this process does, for someone who did not draw it.
//
// Mermaid, counts and one complexity number. Deliberately NOT prose verbalization and
// NOT 7PMG G6 verb-object label checking: G6 is unbounded multilingual NLP on a corpus
// that contains German and French labels, with no library and no accuracy target, and
// the thing reading this output is already a language model. Give it structure it can
// reason over, not paragraphs it could have written itself.
import { parse } from './model.mjs';
import { project } from './ir.mjs';

// Cardoso's control-flow complexity: each split contributes the number of paths it can
// take. XOR contributes one per outgoing branch, OR one per non-empty subset, AND one.
// A single number that says "this process has 7 decisions" is worth more to a reader
// than a page describing them.
function cfc(ir) {
  let total = 0;
  const outs = new Map();
  for (const f of ir.flows || []) outs.set(f.from, (outs.get(f.from) ?? 0) + 1);
  for (const n of ir.nodes || []) {
    const d = outs.get(n.id) ?? 0;
    if (d < 2) continue;
    if (n.type === 'xor' || n.type === 'event_gw') total += d;
    else if (n.type === 'or') total += Math.pow(2, d) - 1;
    else if (n.type === 'and') total += 1;
  }
  return total;
}

const MERMAID_SHAPE = {
  start: (id, l) => `${id}((${l}))`,
  end: (id, l) => `${id}(((${l})))`,
  catch: (id, l) => `${id}((${l}))`,
  throw: (id, l) => `${id}((${l}))`,
  boundary: (id, l) => `${id}((${l}))`,
  xor: (id, l) => `${id}{${l}}`,
  and: (id, l) => `${id}{${l}}`,
  or: (id, l) => `${id}{${l}}`,
  event_gw: (id, l) => `${id}{${l}}`,
  complex: (id, l) => `${id}{${l}}`,
  subprocess: (id, l) => `${id}[[${l}]]`,
  call: (id, l) => `${id}[[${l}]]`,
};
const defaultShape = (id, l) => `${id}[${l}]`;

// Mermaid ids must be identifier-safe; BPMN ids routinely are not (_820c21c0-...).
const safe = (id) => 'n' + id.replace(/[^A-Za-z0-9]/g, '_');
const label = (s) => (s ?? '').replace(/["\n\r]/g, ' ').trim() || '·';

export function mermaid(ir, { maxNodes = 60 } = {}) {
  const nodes = ir.nodes || [];
  const truncated = nodes.length > maxNodes;
  const shown = new Set(nodes.slice(0, maxNodes).map((n) => n.id));
  const lines = ['flowchart LR'];
  for (const n of nodes.slice(0, maxNodes)) {
    const shape = MERMAID_SHAPE[n.type] ?? defaultShape;
    lines.push('  ' + shape(safe(n.id), label(n.name)));
  }
  for (const f of ir.flows || []) {
    if (!shown.has(f.from) || !shown.has(f.to)) continue;
    lines.push(`  ${safe(f.from)} -->${f.if || f.name ? `|${label(f.if || f.name)}|` : ''} ${safe(f.to)}`);
  }
  for (const m of ir.messageFlows || []) {
    if (!shown.has(m.from) || !shown.has(m.to)) continue;
    lines.push(`  ${safe(m.from)} -.->|${label(m.name) === '·' ? 'message' : label(m.name)}| ${safe(m.to)}`);
  }
  return { text: lines.join('\n'), truncated, shown: Math.min(nodes.length, maxNodes) };
}

// Enumerated, not pattern-matched. The IR's type tokens are short names — `user`,
// `send`, `receive` — so a /task/ regex counts a file of six user tasks as zero tasks,
// which is what the first run of this reported. A count that is silently wrong is
// worse than no count: it reads as authoritative.
const WORK = new Set(['task', 'user', 'service', 'send', 'receive', 'manual', 'script', 'rule', 'subprocess', 'call']);
const GATEWAY = new Set(['xor', 'and', 'or', 'event_gw', 'complex']);
const EVENT = new Set(['start', 'end', 'catch', 'throw', 'boundary']);

export function summarise(ir) {
  const byType = {};
  for (const n of ir.nodes || []) byType[n.type] = (byType[n.type] ?? 0) + 1;
  const count = (set) => (ir.nodes || []).filter((n) => set.has(n.type)).length;
  return {
    tasks: count(WORK),
    gateways: count(GATEWAY),
    events: count(EVENT),
    flows: (ir.flows || []).length,
    messageFlows: (ir.messageFlows || []).length,
    pools: (ir.pools || []).length,
    lanes: (ir.lanes || []).length,
    byType,
    cfc: cfc(ir),
  };
}

/** One line, in the product voice: numbers over adjectives, sentence case, one period. */
export function headline(s) {
  const bits = [`${s.tasks} task${s.tasks === 1 ? '' : 's'}`];
  if (s.gateways) bits.push(`${s.gateways} gateway${s.gateways === 1 ? '' : 's'}`);
  if (s.pools) bits.push(`${s.pools} pool${s.pools === 1 ? '' : 's'}`);
  bits.push(`${s.flows} flow${s.flows === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export async function explain(xml, opts = {}) {
  const { definitions } = await parse(xml);
  const ir = project(definitions);
  const summary = summarise(ir);
  return { summary, headline: headline(summary), diagram: mermaid(ir, opts), ir };
}
