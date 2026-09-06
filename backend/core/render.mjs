import { walk } from './document.mjs';
import { diff } from './diff.mjs';
import { project } from './projection.mjs';

/**
 * A read-only SVG of a process, drawn from the DI the file already carries. It exists so a
 * reviewer can see what a review packet describes — nothing here edits, and nothing here lays
 * out: every coordinate comes from the document.
 *
 * It deliberately does not use bpmn-js. That library renders beautifully and carries a licence
 * requiring a visible watermark on every diagram, which is exactly the dependency ADR-009 keeps
 * out of anything published. Each block already declares its shape, and a review only needs to
 * show which box is which and what changed — not to be a modeller.
 */

const ROLE = {
  start: 'event',
  end: 'event',
  catch: 'event',
  throw: 'event',
  boundary: 'event',
  xor: 'gateway',
  and: 'gateway',
  or: 'gateway',
  event_gw: 'gateway',
  complex: 'gateway',
};

const PALETTE = {
  added: '#2C7449',
  removed: '#A63A22',
  rerouted: '#7E6417',
  retyped: '#7E6417',
  reowned: '#0E6B60',
  renamed: '#0E6B60',
};

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// The DI is where every coordinate lives; nothing is invented here.
function geometry(definitions) {
  const shapes = new Map();
  const edges = new Map();
  for (const element of walk(definitions)) {
    const target = element.bpmnElement?.id;
    if (!target) continue;
    if (element.$type === 'bpmndi:BPMNShape' && element.bounds) {
      const { x, y, width, height } = element.bounds;
      shapes.set(target, { x, y, width, height });
    }
    if (element.$type === 'bpmndi:BPMNEdge' && element.waypoint?.length) {
      edges.set(target, element.waypoint.map((point) => [point.x, point.y]));
    }
  }
  return { shapes, edges };
}

function label(text, box) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + word).length > 16 && line) {
      lines.push(line.trim());
      line = '';
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(line.trim());

  const top = box.y + box.height / 2 - ((lines.length - 1) * 12) / 2 + 4;
  return lines
    .slice(0, 3)
    .map(
      (part, index) =>
        `<text x="${box.x + box.width / 2}" y="${top + index * 12}" text-anchor="middle" ` +
        `font-size="10" fill="#14191B">${escape(part)}</text>`,
    )
    .join('');
}

function node(element, box, colour) {
  const stroke = colour ?? '#14191B';
  const fill = colour ? `${colour}22` : '#FBFCFB';
  const role = ROLE[element.type] ?? 'activity';

  if (role === 'event') {
    const r = Math.min(box.width, box.height) / 2;
    const inner = element.type === 'boundary' || element.type === 'catch' || element.type === 'throw';
    return (
      `<circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="${r}" ` +
      `fill="${fill}" stroke="${stroke}" stroke-width="${element.type === 'end' ? 3 : 1.5}"/>` +
      (inner
        ? `<circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="${r - 3}" ` +
          `fill="none" stroke="${stroke}" stroke-width="1"/>`
        : '')
    );
  }
  if (role === 'gateway') {
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    const [rx, ry] = [box.width / 2, box.height / 2];
    return (
      `<polygon points="${cx},${box.y} ${box.x + box.width},${cy} ${cx},${box.y + box.height} ${box.x},${cy}" ` +
      `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      (element.type === 'and'
        ? `<path d="M${cx - rx / 3},${cy} H${cx + rx / 3} M${cx},${cy - ry / 3} V${cy + ry / 3}" stroke="${stroke}" stroke-width="2"/>`
        : element.type === 'xor'
          ? `<path d="M${cx - rx / 3},${cy - ry / 3} L${cx + rx / 3},${cy + ry / 3} M${cx + rx / 3},${cy - ry / 3} L${cx - rx / 3},${cy + ry / 3}" stroke="${stroke}" stroke-width="2"/>`
          : '')
    );
  }
  return (
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
  );
}

/**
 * @param {unknown} definitions
 * @param {{changed?: Record<string, string>, title?: string}} [options]
 *   `changed` maps an element id to a change kind, which colours it.
 */
export function render(definitions, { changed = {}, title = '' } = {}) {
  const ir = project(definitions);
  const nodes = ir.nodes ?? [];
  const { shapes, edges } = geometry(definitions);
  const drawn = [];

  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const extend = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const [id, points] of edges) {
    for (const [x, y] of points) extend(x, y);
    const colour = PALETTE[changed[id]];
    drawn.push(
      `<polyline points="${points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" ` +
        `stroke="${colour ?? '#4E5A5C'}" stroke-width="${colour ? 2.5 : 1.2}" marker-end="url(#arrow)"/>`,
    );
  }

  for (const element of nodes) {
    const box = shapes.get(element.id);
    if (!box) continue;
    extend(box.x, box.y);
    extend(box.x + box.width, box.y + box.height);
    drawn.push(node(element, box, PALETTE[changed[element.id]]));
    if (element.name) drawn.push(label(element.name, box));
  }

  // A file with no DI has nothing to draw, and inventing coordinates is what ADR-003 exists to
  // avoid. Say so in the picture rather than producing an empty one.
  if (!Number.isFinite(minX)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="60" viewBox="0 0 420 60">` +
      `<text x="10" y="34" font-family="system-ui,sans-serif" font-size="13" fill="#A63A22">` +
      `This document carries no DI, so there is nothing to draw.</text></svg>\n`;
  }

  const pad = 24;
  const [width, height] = [maxX - minX + pad * 2, maxY - minY + pad * 2 + (title ? 24 : 0)];
  const top = minY - pad - (title ? 24 : 0);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" ` +
    `viewBox="${minX - pad} ${top} ${width} ${height}" font-family="system-ui,sans-serif">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" ` +
    `orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#4E5A5C"/></marker></defs>` +
    `<rect x="${minX - pad}" y="${top}" width="${width}" height="${height}" fill="#F1F3F2"/>` +
    (title
      ? `<text x="${minX - pad + 12}" y="${top + 18}" font-size="12" fill="#4E5A5C">${escape(title)}</text>`
      : '') +
    drawn.join('') +
    `</svg>\n`
  );
}

/** The colouring a review implies: what changed, and how. */
export async function changesFrom(beforeXml, afterXml) {
  const summary = await diff(beforeXml, afterXml);
  const changed = {};
  for (const kind of ['added', 'removed', 'renamed', 'rerouted', 'retyped', 'reowned']) {
    for (const entry of summary[kind]) changed[entry.id] = kind;
  }
  return changed;
}
