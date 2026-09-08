import { parse } from './document.mjs';
import { diffSanity, scoreAll } from './gates.mjs';
import { project } from './projection.mjs';
import { risk } from './ops.mjs';
import { simulate } from './simulate.mjs';

/**
 * What changed between two versions of a process, by id. Ids are preserved across an edit, so a
 * rename is a rename rather than a removal and an addition — which is the difference between a
 * diff a reviewer can read and a wall of XML.
 *
 * @typedef {object} Difference
 * @property {{id: string, type: string, name?: string}[]} added
 * @property {{id: string, type: string, name?: string}[]} removed
 * @property {{id: string, from: string, to: string}[]} renamed
 * @property {{id: string, from: string, to: string, was: string}[]} rerouted
 * @property {{id: string, from: string, to: string}[]} retyped
 * @property {{id: string, from: string, to: string}[]} reowned      lane membership
 * @property {number} shapesMoved
 * @property {number} distinctDeltas
 */

const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

const list = (ir, key) => ir[key] ?? [];

function indexOf(ir) {
  const byId = new Map();
  for (const node of list(ir, 'nodes')) byId.set(node.id, { kind: 'node', ...node });
  for (const key of ['flows', 'messageFlows']) {
    for (const flow of list(ir, key)) byId.set(flow.id, { kind: 'flow', ...flow });
  }
  return byId;
}

const laneNames = (ir) =>
  new Map(list(ir, 'lanes').map((lane) => [lane.id, clean(lane.name) || lane.id]));

export async function diff(beforeXml, afterXml) {
  const before = project((await parse(beforeXml)).definitions);
  const after = project((await parse(afterXml)).definitions);
  const was = indexOf(before);
  const now = indexOf(after);
  const lanes = { before: laneNames(before), after: laneNames(after) };

  const summary = { added: [], removed: [], renamed: [], rerouted: [], retyped: [], reowned: [] };
  const describe = (element) => ({
    id: element.id,
    type: element.type ?? 'flow',
    ...(element.name ? { name: clean(element.name) } : {}),
  });

  for (const [id, element] of now) if (!was.has(id)) summary.added.push(describe(element));
  for (const [id, element] of was) if (!now.has(id)) summary.removed.push(describe(element));

  for (const [id, then] of was) {
    const next = now.get(id);
    if (!next) continue;
    if (clean(then.name) !== clean(next.name)) {
      summary.renamed.push({ id, from: clean(then.name), to: clean(next.name) });
    }
    if (then.type !== next.type) summary.retyped.push({ id, from: then.type, to: next.type });
    if (then.kind === 'flow' && then.to !== next.to) {
      summary.rerouted.push({ id, from: next.from, to: next.to, was: then.to });
    }
    if (then.lane !== next.lane) {
      summary.reowned.push({
        id,
        from: lanes.before.get(then.lane) ?? 'no lane',
        to: lanes.after.get(next.lane) ?? 'no lane',
      });
    }
  }

  const { shapesMoved, distinctDeltas } = diffSanity(beforeXml, afterXml);
  return { ...summary, shapesMoved, distinctDeltas };
}

// The plan a diff implies, so the packet can state a risk level the same way an op does rather
// than inventing a second scale for the same thing.
function planOf(summary) {
  return [
    ...summary.added.map(() => ({ op: 'add', type: 'task', in: 'x' })),
    ...summary.removed.map((entry) => ({ op: 'del', id: entry.id })),
    ...summary.rerouted.map((entry) => ({ op: 'set', id: entry.id, patch: { to: entry.to } })),
    ...summary.reowned.map((entry) => ({ op: 'set', id: entry.id, patch: { lane: entry.to } })),
    ...summary.renamed.map((entry) => ({ op: 'set', id: entry.id, patch: { name: entry.to } })),
  ];
}

const hours = (secs) => `${Math.round((secs / 3600) * 10) / 10}h`;

function section(title, rows) {
  if (!rows.length) return [];
  return ['', `**${title}**`, '', ...rows.map((row) => `- ${row}`)];
}

/**
 * A reviewer reads this, not the XML. It says what changed, why, what it risks, and what it costs
 * — and it says nothing about cost when it does not know, because a number beside a caveat gets
 * quoted without the caveat.
 */
export async function review(beforeXml, afterXml, { explain = [], when = {}, level } = {}) {
  const summary = await diff(beforeXml, afterXml);
  const { gates } = await scoreAll(beforeXml, afterXml, { expectChangedIds: [] });
  const failed = Object.entries(gates).filter(
    ([name, gate]) => !gate.ok && name !== 'noCollateral',
  );

  const lines = ['# Review', ''];
  for (const sentence of explain) lines.push(sentence);
  if (explain.length) lines.push('');

  lines.push(
    level
      ? `risk     ${level}`
      : `risk     ${risk(planOf(summary))} (derived from the diff; an op reports its own, and knows more)`,
  );
  lines.push(
    `diagram  ${summary.shapesMoved} shapes moved, ${summary.distinctDeltas} distinct delta` +
      `${summary.distinctDeltas === 1 ? '' : 's'}` +
      `${summary.distinctDeltas > 1 ? ' — the diagram was reflowed' : ''}`,
  );

  const before = simulate((await parse(beforeXml)).definitions, { when, runs: 200, seed: 1 });
  const after = simulate((await parse(afterXml)).definitions, { when, runs: 200, seed: 1 });
  if (before.synthetic || after.synthetic || before.p50 === null || after.p50 === null) {
    lines.push(
      'cycle    no estimate — annotate the steps with <treadle:duration p50="PT4H"/> and give a ' +
        'scenario for each gateway',
    );
  } else {
    lines.push(`cycle    p50 ${hours(before.p50)} → ${hours(after.p50)}, p90 ${hours(before.p90)} → ${hours(after.p90)}`);
  }

  lines.push(
    ...section('gates', failed.map(([name, gate]) =>
      `${name}: ${JSON.stringify(gate.introduced ?? gate.errors ?? gate.findings ?? gate).slice(0, 160)}`)),
    ...section('added', summary.added.map((e) => `\`${e.id}\` ${e.type}${e.name ? ` — ${e.name}` : ''}`)),
    ...section('removed', summary.removed.map((e) => `\`${e.id}\` ${e.type}${e.name ? ` — ${e.name}` : ''}`)),
    ...section('renamed', summary.renamed.map((e) => `\`${e.id}\` — "${e.from}" → "${e.to}"`)),
    ...section('rerouted', summary.rerouted.map((e) => `\`${e.id}\` — now ${e.from} → ${e.to}, was → ${e.was}`)),
    ...section('retyped', summary.retyped.map((e) => `\`${e.id}\` — ${e.from} → ${e.to}`)),
    ...section('reowned', summary.reowned.map((e) => `\`${e.id}\` — ${e.from} → ${e.to}`)),
  );

  if (!failed.length) lines.push('', 'Every gate passed.');
  return `${lines.join('\n')}\n`;
}
