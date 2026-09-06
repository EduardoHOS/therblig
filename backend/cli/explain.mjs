// A deterministic reading of a process. No model is called: everything here is derived from the
// IR, so the same file always produces the same bytes and a diff of two explanations is meaningful.

const NODE_ORDER = ['start', 'end', 'catch', 'throw', 'boundary'];

function histogram(nodes) {
  const counts = new Map();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => {
      const rank = (type) => (NODE_ORDER.includes(type) ? NODE_ORDER.indexOf(type) : NODE_ORDER.length);
      return rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]);
    })
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
}

// The straight run from a start event, stopping where the graph first branches or rejoins.
function spine(ir, start, nameOf) {
  const seen = new Set();
  const steps = [nameOf(start)];
  let current = start;
  for (;;) {
    const exits = ir.flows.filter((flow) => flow.from === current.id);
    if (exits.length !== 1) break;
    const next = ir.nodes.find((node) => node.id === exits[0].to);
    if (!next || seen.has(next.id)) break;
    const entries = ir.flows.filter((flow) => flow.to === next.id);
    seen.add(next.id);
    steps.push(nameOf(next));
    if (entries.length !== 1) break;
    current = next;
  }
  return steps;
}

function reach(nodes, flows, { seeds, forward }) {
  const edges = new Map();
  for (const flow of flows) {
    const [from, to] = forward ? [flow.from, flow.to] : [flow.to, flow.from];
    edges.set(from, [...(edges.get(from) ?? []), to]);
  }

  const seen = new Set();
  const queue = [];
  const seed = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    queue.push(id);
  };
  for (const id of seeds) seed(id);

  for (;;) {
    while (queue.length) for (const next of edges.get(queue.pop()) ?? []) seed(next);
    const woken = nodes.filter((node) => node.on && seen.has(node.on) && !seen.has(node.id));
    if (!woken.length) return seen;
    for (const node of woken) seed(node.id);
  }
}

export function explain(name, ir) {
  const nameOf = (node) => (node.name ?? node.id).replace(/\s+/g, ' ').trim();
  const lines = [];
  const counts = [
    [ir.processes?.length, 'process', 'processes'],
    [ir.pools?.length, 'pool', 'pools'],
    [ir.lanes?.length, 'lane', 'lanes'],
    [ir.messageFlows?.length, 'message flow', 'message flows'],
  ]
    .filter(([count]) => count)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  lines.push(`${name} — ${counts.join(', ')}`);

  for (const process of ir.processes ?? []) {
    const nodes = (ir.nodes ?? []).filter((node) => node.in === process.id);
    if (!nodes.length) continue;
    const pool = (ir.pools ?? []).find((candidate) => candidate.process === process.id);

    lines.push('');
    lines.push(
      `${pool ? `${nameOf(pool)} / ` : ''}${nameOf(process)}${process.executable ? ' (executable)' : ''}`,
    );
    lines.push(`  ${nodes.length} nodes: ${histogram(nodes)}`);

    for (const lane of (ir.lanes ?? []).filter((candidate) => candidate.in === process.id)) {
      const members = nodes.filter((node) => node.lane === lane.id).length;
      lines.push(`  lane ${nameOf(lane)}: ${members} ${members === 1 ? 'node' : 'nodes'}`);
    }

    const ids = new Set(nodes.map((node) => node.id));
    const flows = (ir.flows ?? []).filter((flow) => ids.has(flow.from) && ids.has(flow.to));
    for (const start of nodes.filter((node) => node.type === 'start')) {
      lines.push(`  ${spine({ ...ir, flows }, start, nameOf).join(' → ')}`);
    }

    const handlers = nodes.filter((node) => node.type === 'boundary');
    if (handlers.length) {
      lines.push('  handlers:');
      for (const handler of handlers) {
        const host = nodes.find((node) => node.id === handler.on);
        const to = flows.find((flow) => flow.from === handler.id);
        const target = to && nodes.find((node) => node.id === to.to);
        const kind = Array.isArray(handler.event) ? handler.event.join('+') : (handler.event ?? 'plain');
        lines.push(
          `    ${kind} on ${host ? `"${nameOf(host)}"` : '(nothing)'} → ${target ? `"${nameOf(target)}"` : '(nowhere)'}`,
        );
      }
    }

    // The two questions a reader cannot answer by looking: what can never run, and what never ends.
    // An event subprocess is a scope of its own — it is triggered, not flowed into, and it holds
    // its own end — so it is neither unreachable nor a dead end.
    const scoped = (node) => !node.eventSubprocess;
    const triggered = nodes
      .filter((node) => node.type === 'start' || node.eventSubprocess)
      .map((node) => node.id);
    const ends = nodes.filter((node) => node.type === 'end').map((node) => node.id);
    const forward = reach(nodes, flows, { seeds: triggered, forward: true });
    const backward = reach(nodes, flows, { seeds: ends, forward: false });
    const orphan = nodes.filter((node) => scoped(node) && !forward.has(node.id));
    const dead = nodes.filter(
      (node) => scoped(node) && forward.has(node.id) && !backward.has(node.id),
    );

    lines.push(`  unreachable from a start: ${orphan.length ? orphan.map(nameOf).join(', ') : 'none'}`);
    lines.push(`  reaches no end: ${dead.length ? dead.map(nameOf).join(', ') : 'none'}`);
  }

  return lines.join('\n');
}
