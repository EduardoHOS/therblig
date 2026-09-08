// BPMN to SVG, from the DI coordinates already in the file.
//
// No bpmn-js, no diagram-js, no DOM, no jsdom, no headless browser. Every coordinate a
// renderer needs is in the document — 1,521 dc:Bounds and 1,359 waypoints across the
// corpus — so drawing it is string building, and ADR-009's quarantine stays intact
// without an optional viewer package.
//
// It emits SVG only. That is a real limitation stated plainly: vision models do not
// read SVG and MCP image content wants a raster mimeType, so this is NOT a "let the
// agent look at what it did" loop. It is an artifact for a pull request and for a human
// reviewer, and it is sold as exactly that.
//
// BPMN LOCK (from the brand brief): notation is not negotiable. Task is a rounded rect,
// start a thin circle, end a thick circle, intermediate a double circle, gateway a
// diamond, sequence flow solid with a filled arrowhead, message flow dashed with an
// open one. Brand may style fill, stroke colour, radius, type and spacing — never the
// shape, the line or the arrowhead semantics.
import { walk } from '../core/document.mjs';

// The palette, verbatim from the brief. signal is for errors and invalid flows and is
// NEVER decoration, which is why the diff below does not use it to mean "removed".
export const TOKENS = {
  paper: '#F7F4EE',
  desk: '#EAE5DB',
  rule: '#D9D3C7',
  pencil: '#6B665E',
  ink: '#1C1A17',
  signal: '#B5432E',
};

// The radius law is 30% of the shorter side. The brief's own audit records that this is
// unworkable above small elements — 30% of an 80px task is 24px, which stops reading as
// BPMN — so it applies to elements up to 64px and a documented constant is used above.
const radius = (w, h) => (Math.min(w, h) <= 64 ? Math.min(w, h) * 0.3 : 10);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const TASK = /Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:CallActivity$|^bpmn:Transaction$/;
const GATEWAY = /^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$/;
const EVENT = /Event$/;

/** Collect every shape and edge with its element, from the moddle tree. */
function collect(definitions) {
  const shapes = [], edges = [];
  for (const el of walk(definitions)) {
    if (el.$type === 'bpmndi:BPMNShape' && el.bounds && el.bpmnElement) {
      shapes.push({
        id: el.bpmnElement.id,
        type: el.bpmnElement.$type,
        name: el.bpmnElement.name,
        eventDefs: (el.bpmnElement.eventDefinitions || []).map((d) => d.$type),
        isExpanded: el.isExpanded,
        horizontal: el.isHorizontal !== false,
        x: el.bounds.x, y: el.bounds.y, w: el.bounds.width, h: el.bounds.height,
        label: el.label?.bounds ? { x: el.label.bounds.x, y: el.label.bounds.y, w: el.label.bounds.width, h: el.label.bounds.height } : null,
      });
    }
    if (el.$type === 'bpmndi:BPMNEdge' && el.waypoint?.length && el.bpmnElement) {
      edges.push({
        id: el.bpmnElement.id,
        type: el.bpmnElement.$type,
        name: el.bpmnElement.name,
        points: el.waypoint.map((p) => ({ x: p.x, y: p.y })),
      });
    }
  }
  return { shapes, edges };
}

// --- element painters --------------------------------------------------------

function paintEvent(s, stroke) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, r = Math.min(s.w, s.h) / 2;
  // Stroke WEIGHT is the notation: thin start, thick end, double ring intermediate.
  const isEnd = s.type === 'bpmn:EndEvent';
  const isIntermediate = /Intermediate|Boundary/.test(s.type);
  const out = [`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${TOKENS.paper}" stroke="${stroke}" stroke-width="${isEnd ? 3.5 : 1.5}"/>`];
  if (isIntermediate) out.push(`<circle cx="${cx}" cy="${cy}" r="${r - 3}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
  // A glyph for the kinds that carry one; unglyphed kinds stay a plain circle.
  const d = s.eventDefs[0] ?? '';
  if (/Timer/.test(d)) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="none" stroke="${stroke}" stroke-width="1"/><path d="M${cx} ${cy - r * 0.4}V${cy}h${r * 0.3}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
  else if (/Message/.test(d)) out.push(`<rect x="${cx - r * 0.45}" y="${cy - r * 0.32}" width="${r * 0.9}" height="${r * 0.64}" fill="none" stroke="${stroke}" stroke-width="1"/><path d="M${cx - r * 0.45} ${cy - r * 0.32}L${cx} ${cy + r * 0.05}L${cx + r * 0.45} ${cy - r * 0.32}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
  else if (/Error/.test(d)) out.push(`<path d="M${cx - r * 0.4} ${cy + r * 0.4}l${r * 0.3} -${r * 0.55} l${r * 0.25} ${r * 0.3} l${r * 0.3} -${r * 0.55}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`);
  else if (/Terminate/.test(d)) out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="${stroke}"/>`);
  else if (/Signal/.test(d)) out.push(`<path d="M${cx} ${cy - r * 0.45}L${cx + r * 0.45} ${cy + r * 0.35}L${cx - r * 0.45} ${cy + r * 0.35}Z" fill="none" stroke="${stroke}" stroke-width="1"/>`);
  return out.join('');
}

function paintGateway(s, stroke) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, r = Math.min(s.w, s.h) / 2;
  const out = [`<path d="M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z" fill="${TOKENS.paper}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`];
  const g = r * 0.42;
  if (s.type === 'bpmn:ExclusiveGateway') {
    out.push(`<path d="M${cx - g} ${cy - g}L${cx + g} ${cy + g}M${cx + g} ${cy - g}L${cx - g} ${cy + g}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`);
  } else if (s.type === 'bpmn:ParallelGateway') {
    out.push(`<path d="M${cx} ${cy - g}V${cy + g}M${cx - g} ${cy}H${cx + g}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`);
  } else if (s.type === 'bpmn:InclusiveGateway') {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${g}" fill="none" stroke="${stroke}" stroke-width="2"/>`);
  } else if (s.type === 'bpmn:EventBasedGateway') {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${g}" fill="none" stroke="${stroke}" stroke-width="1"/><circle cx="${cx}" cy="${cy}" r="${g * 0.7}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
  }
  return out.join('');
}

function paintContainer(s, stroke) {
  // A pool is a container with a vertical name band. That band IS the notation, not a
  // styling choice, so it is drawn even when the brand would rather not.
  const band = 30;
  const out = [`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="10" fill="none" stroke="${stroke}" stroke-width="1.2"/>`];
  if (s.type === 'bpmn:Participant' || s.type === 'bpmn:Lane') {
    out.push(`<path d="M${s.x + band} ${s.y}V${s.y + s.h}" stroke="${stroke}" stroke-width="1.2"/>`);
    if (s.name) {
      const cy = s.y + s.h / 2, cx = s.x + band / 2;
      out.push(`<text x="${cx}" y="${cy}" transform="rotate(-90 ${cx} ${cy})" text-anchor="middle" dominant-baseline="central" font-family="'IBM Plex Mono', monospace" font-size="11" font-weight="500" letter-spacing="0.08em" fill="${TOKENS.pencil}">${esc(s.name.toUpperCase())}</text>`);
    }
  }
  return out.join('');
}

function paintTask(s, stroke, fill) {
  return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${radius(s.w, s.h)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
}

// Text inside a shape, wrapped to the box. Naive width estimate: Plex Mono at 11px is
// about 6.6px per character, and a diagram label that overflows by a character is a
// smaller problem than pulling in a text-metrics dependency.
function paintLabel(s, colour) {
  if (!s.name) return '';
  // A gateway label goes ABOVE the diamond, never inside it: the glyph is the notation
  // and text over it obscures the one mark that says which kind of gateway this is.
  // Events and gateways use their BPMNLabel bounds when the file supplies them.
  const box = TASK.test(s.type)
    ? s
    : GATEWAY.test(s.type)
      ? (s.label ?? { x: s.x - 30, y: s.y - 26, w: s.w + 60, h: 22 })
      : (s.label ?? { x: s.x - 20, y: s.y + s.h + 4, w: s.w + 40, h: 24 });
  const perLine = Math.max(4, Math.floor((box.w - 8) / 6.6));
  const words = String(s.name).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > perLine && line) { lines.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 4);
  const cx = box.x + box.w / 2;
  const startY = box.y + box.h / 2 - ((shown.length - 1) * 13) / 2;
  return shown.map((l, i) =>
    `<text x="${cx}" y="${startY + i * 13}" text-anchor="middle" dominant-baseline="central" font-family="'IBM Plex Mono', monospace" font-size="11" font-weight="500" fill="${colour}">${esc(l)}</text>`,
  ).join('');
}

function paintEdge(e, stroke, dashed) {
  const d = e.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('');
  const marker = e.type === 'bpmn:MessageFlow' ? 'open' : 'filled';
  const dash = dashed || e.type === 'bpmn:MessageFlow' ? ' stroke-dasharray="6 4"' : '';
  const out = [`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"${dash} marker-end="url(#arrow-${marker})" stroke-linejoin="round"/>`];
  if (e.name) {
    const mid = e.points[Math.floor(e.points.length / 2)];
    out.push(`<text x="${mid.x}" y="${mid.y - 6}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="10" fill="${TOKENS.pencil}">${esc(e.name)}</text>`);
  }
  return out.join('');
}

/**
 * Render a document.
 *
 * `diff` optionally carries { added:Set, removed:Set, moved:Map<id, {dx,dy}> } and a
 * `ghosts` list of shapes at their previous positions.
 *
 * Deviation from the plan, on purpose: the plan said colour added green, removed red,
 * moved amber. The brand has no green or amber, and its own audit is explicit that
 * inventing colours is a violation and that signal is never decoration. A removal you
 * asked for is also not an error. So: added is ink at full weight, removed and moved-from
 * are pencil ghosts, everything untouched recedes to rule. Signal appears only where the
 * validator put it.
 */
export function renderTree(definitions, { diff = null, title = null } = {}) {
  const { shapes, edges: edgeList } = collect(definitions);
  if (!shapes.length && !edgeList.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><text x="16" y="44" font-family="'IBM Plex Mono', monospace" font-size="12" fill="${TOKENS.pencil}">This file has no diagram to draw.</text></svg>`;
  }

  const xs = [], ys = [];
  for (const s of shapes) { xs.push(s.x, s.x + s.w); ys.push(s.y, s.y + s.h); }
  for (const e of edgeList) for (const p of e.points) { xs.push(p.x); ys.push(p.y); }
  for (const g of diff?.ghosts ?? []) { xs.push(g.x, g.x + g.w); ys.push(g.y, g.y + g.h); }
  const pad = 32;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad, h = Math.max(...ys) - minY + pad;

  const added = diff?.added ?? new Set();
  const removed = diff?.removed ?? new Set();
  const moved = diff?.moved ?? new Set();
  const flagged = diff?.flagged ?? new Set();
  const quiet = !!diff;   // in diff mode, untouched content recedes

  const strokeFor = (id) => {
    if (flagged.has(id)) return TOKENS.signal;
    if (added.has(id)) return TOKENS.ink;
    if (removed.has(id)) return TOKENS.pencil;
    if (moved.has(id)) return TOKENS.ink;
    return quiet ? TOKENS.rule : TOKENS.ink;
  };
  const textFor = (id) => (quiet && !added.has(id) && !moved.has(id) && !flagged.has(id) ? TOKENS.rule : TOKENS.ink);

  const body = [];

  // Ghosts first, underneath: where a moved shape used to be.
  for (const g of diff?.ghosts ?? []) {
    body.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="${radius(g.w, g.h)}" fill="none" stroke="${TOKENS.rule}" stroke-width="1" stroke-dasharray="3 3"/>`);
  }

  // Containers under content.
  for (const s of shapes.filter((s) => s.type === 'bpmn:Participant' || s.type === 'bpmn:Lane')) {
    body.push(paintContainer(s, strokeFor(s.id)));
  }
  for (const e of edgeList) body.push(paintEdge(e, strokeFor(e.id), removed.has(e.id)));
  for (const s of shapes) {
    if (s.type === 'bpmn:Participant' || s.type === 'bpmn:Lane') continue;
    const stroke = strokeFor(s.id);
    if (EVENT.test(s.type)) body.push(paintEvent(s, stroke));
    else if (GATEWAY.test(s.type)) body.push(paintGateway(s, stroke));
    else if (TASK.test(s.type)) body.push(paintTask(s, stroke, added.has(s.id) ? TOKENS.desk : TOKENS.paper));
    else body.push(paintTask(s, stroke, TOKENS.paper));
    body.push(paintLabel(s, textFor(s.id)));
  }

  const defs =
    `<defs>` +
    `<marker id="arrow-filled" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${TOKENS.ink}"/></marker>` +
    `<marker id="arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="none" stroke="${TOKENS.ink}" stroke-width="1.4"/></marker>` +
    `</defs>`;

  const caption = title
    ? `<text x="${minX + 12}" y="${minY + 20}" font-family="'IBM Plex Mono', monospace" font-size="11" font-weight="500" letter-spacing="0.08em" fill="${TOKENS.pencil}">${esc(title.toUpperCase())}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="'IBM Plex Mono', monospace">` +
    defs +
    `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${TOKENS.desk}"/>` +
    caption + body.join('') +
    `</svg>`;
}
