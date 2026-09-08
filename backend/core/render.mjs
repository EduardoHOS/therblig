import { walk } from './document.mjs';
import { diff } from './diff.mjs';
import { project } from './projection.mjs';
import { byIr, eventGlyphs } from './registry.mjs';

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


// The drawing is read in a light CLI file and in a dark studio, so the four structural colours are
// custom properties the page can set. The fallback is the light palette, which is what a `.svg`
// opened on its own resolves to.
const INK = 'var(--treadle-ink, #14191B)';
const GROUND = 'var(--treadle-ground, #F1F3F2)';
const SURFACE = 'var(--treadle-surface, #FBFCFB)';
const LINE = 'var(--treadle-line, #4E5A5C)';

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
  const labels = new Map();
  const edges = new Map();
  for (const element of walk(definitions)) {
    const target = element.bpmnElement?.id;
    if (!target) continue;
    if (element.$type === 'bpmndi:BPMNShape' && element.bounds) {
      const { x, y, width, height } = element.bounds;
      shapes.set(target, {
        x,
        y,
        width,
        height,
        // `isHorizontal` says which edge a pool or lane hangs its name band on; `isExpanded` says
        // whether a subprocess shows its contents. Both are absent on everything else.
        horizontal: element.isHorizontal !== false,
        expanded: element.isExpanded === true,
      });
      // A BPMNLabel may carry its own bounds, and when it does the document has already decided
      // where the name belongs — usually beside or below a shape too small to hold it.
      const placed = element.label?.bounds;
      if (placed) {
        labels.set(target, {
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
        });
      }
    }
    if (element.$type === 'bpmndi:BPMNEdge' && element.waypoint?.length) {
      edges.set(target, element.waypoint.map((point) => [point.x, point.y]));
    }
  }
  return { shapes, labels, edges };
}

// An event or a gateway is too small to hold its own name; when the document does not say where
// the label goes, it goes underneath rather than across the glyph.
function labelBox(element, box, placed) {
  if (placed) return placed;
  if (roleOf(element) === 'activity') return box;
  return { x: box.x + box.width / 2 - 40, y: box.y + box.height + 2, width: 80, height: 14 };
}

// The renderer keeps no table of its own: a block declares what family it belongs to, what mark it
// wears, and how heavy its border is. Adding a block therefore cannot forget to be drawable.
const roleOf = (element) => byIr.get(element.type).role;

/**
 * A mark placed inside a shape. Every glyph is authored in a 16×16 box, so the only thing to decide
 * here is where it sits and how big — the vocabulary itself lives in `blocks/`.
 */
function mark(name, art, box, { size, at, filled = false }) {
  const scale = size / 16;
  const [x, y] =
    at === 'corner'
      ? [box.x + 5, box.y + 5]
      : at === 'bottom'
        ? [box.x + box.width / 2 - size / 2, box.y + box.height - size - 4]
        : [box.x + box.width / 2 - size / 2, box.y + box.height / 2 - size / 2];

  return (
    `<g data-glyph="${name}" transform="translate(${round(x)} ${round(y)}) scale(${round(scale)})" ` +
    `fill="${filled ? INK : 'none'}" stroke="${INK}" stroke-width="${round(1.4 / scale)}" ` +
    `stroke-linecap="round" stroke-linejoin="round" pointer-events="none">${art}</g>`
  );
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * A name, wrapped to the box the document gave it. It carries the id of what it names: the text is
 * a sibling of the shape, not a child, so anything hit-testing from the text upwards would reach
 * the drawing root and conclude that nothing was clicked.
 */
function label(id, text, box) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const wrap = Math.max(8, Math.round(box.width / 5.5));
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + word).length > wrap && line) {
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
        `<text${tag(id, 'label')} x="${box.x + box.width / 2}" y="${top + index * 12}" ` +
        `text-anchor="middle" font-size="10" fill="${INK}">${escape(part)}</text>`,
    )
    .join('');
}

// A pool or a lane is a body with a name band down one side. The band is 30 wide because that is
// what every BPMN tool draws and what the DI of a real file leaves room for.
const BAND = 30;

function container(id, kind, box, name) {
  const [bandWidth, bandHeight] = box.horizontal ? [BAND, box.height] : [box.width, BAND];
  const [cx, cy] = [box.x + bandWidth / 2, box.y + bandHeight / 2];
  const divider = box.horizontal
    ? `M${box.x + BAND},${box.y} V${box.y + box.height}`
    : `M${box.x},${box.y + BAND} H${box.x + box.width}`;

  return (
    `<rect${tag(id, kind)} x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ` +
    `fill="none" stroke="${INK}" stroke-width="${kind === 'pool' ? 1.5 : 1}"/>` +
    `<path d="${divider}" fill="none" stroke="${INK}" stroke-width="1"/>` +
    (name
      ? `<text${tag(id, 'label')} x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" ` +
        `fill="${INK}"` +
        (box.horizontal ? ` transform="rotate(-90 ${cx} ${cy})"` : '') +
        `>${escape(name)}</text>`
      : '')
  );
}

/**
 * An artifact: what the process reads, writes, or says about itself. None of these is a flow node —
 * they carry no token — and the notation keeps them visibly apart from the ones that do.
 */
function artifact(id, kind, box, text) {
  const [w, h] = [box.width, box.height];
  const label = (value, y) =>
    value
      ? `<text${tag(id, 'label')} x="${round(box.x + w / 2)}" y="${round(y)}" text-anchor="middle" ` +
        `font-size="10" fill="${INK}">${escape(String(value).slice(0, 40))}</text>`
      : '';

  if (kind === 'group') {
    return (
      `<rect${tag(id, kind)} x="${box.x}" y="${box.y}" width="${w}" height="${h}" rx="10" ` +
      `fill="none" stroke="${LINE}" stroke-width="1.5" stroke-dasharray="10 4 2 4"/>` +
      label(text, box.y + 14)
    );
  }
  if (kind === 'note') {
    // An annotation is an open bracket, not a box: BPMN draws only the left edge.
    return (
      `<path${tag(id, kind)} d="M${box.x + 10},${box.y} H${box.x} V${box.y + h} H${box.x + 10}" ` +
      `fill="none" stroke="${INK}" stroke-width="1"/>` +
      (text
        ? `<text${tag(id, 'label')} x="${round(box.x + 14)}" y="${round(box.y + 14)}" ` +
          `font-size="10" fill="${INK}">${escape(String(text).slice(0, 60))}</text>`
        : '')
    );
  }
  if (kind === 'store') {
    const r = Math.min(8, h / 5);
    return (
      `<path${tag(id, kind)} d="M${box.x},${box.y + r} a${w / 2},${r} 0 0 1 ${w},0 v${h - r * 2} ` +
      `a${w / 2},${r} 0 0 1 ${-w},0 z" fill="${SURFACE}" stroke="${INK}" stroke-width="1.2"/>` +
      `<path d="M${box.x},${box.y + r} a${w / 2},${r} 0 0 0 ${w},0" fill="none" stroke="${INK}" ` +
      `stroke-width="1.2"/>` +
      label(text, box.y + h + 12)
    );
  }
  // A data object is a page with its corner turned down; an input or an output says which way it
  // goes with an arrow in that corner.
  const fold = 12;
  return (
    `<path${tag(id, kind)} d="M${box.x},${box.y} h${w - fold} l${fold},${fold} v${h - fold} ` +
    `h${-w} z" fill="${SURFACE}" stroke="${INK}" stroke-width="1.2"/>` +
    `<path d="M${box.x + w - fold},${box.y} v${fold} h${fold}" fill="none" stroke="${INK}" ` +
    `stroke-width="1.2"/>` +
    (kind === 'input' || kind === 'output'
      ? `<path d="M${box.x + 4},${box.y + 10} h6 M${box.x + 9},${box.y + 6.5} l4,3.5 l-4,3.5 z" ` +
        `fill="${kind === 'output' ? INK : 'none'}" stroke="${INK}" stroke-width="1.2"/>`
      : '') +
    label(text, box.y + h + 12)
  );
}

// Every drawn element carries its id, so anything reading the SVG — a viewer, a reviewer's
// browser, a screenshot diff — can say which element a shape is without guessing at coordinates.
const tag = (id, kind) => ` data-id="${escape(id)}" data-kind="${kind}"`;

/**
 * What a drawn node states about itself. The picture is also the index: an agent that has the SVG
 * can answer what a shape is, what holds it, whose lane it is in, what it is attached to and what
 * it is waiting for, without opening the file again. Absent facts are absent attributes.
 */
function identify(element, changed) {
  const facts = {
    in: element.in,
    lane: element.lane,
    on: element.on,
    event: element.event === undefined ? undefined : [element.event].flat().join(' '),
    changed,
  };
  return (
    tag(element.id, element.type) +
    Object.entries(facts)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => ` data-${key}="${escape(value)}"`)
      .join('')
  );
}

/**
 * One node: the outline its family gives it, and the mark its type or its event kind gives it.
 * Everything the shape knows about itself comes from the block, so the drawing and the vocabulary
 * cannot drift apart.
 */
function node(element, box, colour, changed) {
  const block = byIr.get(element.type);
  const stroke = colour ?? INK;
  const fill = colour ? `${colour}22` : SURFACE;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const id = identify(element, changed);

  if (block.role === 'event') {
    const r = Math.min(box.width, box.height) / 2;
    // A non-interrupting boundary event does not kill its host, and BPMN says so with a dashed ring.
    const dash = element.interrupting === false ? ` stroke-dasharray="4 3"` : '';
    const [kind] = [element.event ?? []].flat();
    return (
      `<circle${id} cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" ` +
      `stroke-width="${block.ring === 'thick' ? 3 : 1.5}"${dash}/>` +
      (block.ring === 'double'
        ? `<circle cx="${cx}" cy="${cy}" r="${r - 3}" fill="none" stroke="${stroke}" ` +
          `stroke-width="1"${dash}/>`
        : '') +
      (eventGlyphs.has(kind)
        ? mark(kind, eventGlyphs.get(kind), box, { size: r, at: 'centre', filled: block.throwing })
        : '')
    );
  }

  if (block.role === 'gateway') {
    return (
      `<polygon${id} points="${cx},${box.y} ${box.x + box.width},${cy} ${cx},${box.y + box.height} ` +
      `${box.x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      mark(element.type, block.glyph, box, { size: box.width * 0.42, at: 'centre' })
    );
  }

  // An expanded subprocess shows its contents; a collapsed one shows the plus that says there are
  // contents to show. The DI is what knows which, so `expanded` comes from the shape.
  const collapsed = element.type === 'subprocess' && !box.expanded;
  return (
    `<rect${id} x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${block.border ?? 1.5}"/>` +
    (block.glyph && (element.type !== 'subprocess' || collapsed)
      ? mark(element.type, block.glyph, box, { size: 15, at: collapsed ? 'bottom' : 'corner' })
      : '')
  );
}

/**
 * The mark at a flow's source. Both are drawn across the first segment, so they follow whatever
 * direction the DI gave the edge rather than assuming it runs left to right.
 */
function flowMark(kind, points) {
  const [[x1, y1], [x2, y2]] = points;
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
  const at = Math.min(14, length / 2);
  const [cx, cy] = [x1 + ux * at, y1 + uy * at];
  const angle = round((Math.atan2(uy, ux) * 180) / Math.PI);

  return kind === 'default'
    ? `<path data-mark="default" d="M${round(cx - 4)},${round(cy + 5)} L${round(cx + 4)},${round(cy - 5)}" ` +
      `stroke="${LINE}" stroke-width="1.4" transform="rotate(${angle} ${round(cx)} ${round(cy)})"/>`
    : `<path data-mark="conditional" d="M${round(cx - 6)},${round(cy)} L${round(cx)},${round(cy - 4)} ` +
      `L${round(cx + 6)},${round(cy)} L${round(cx)},${round(cy + 4)} z" fill="${GROUND}" ` +
      `stroke="${LINE}" stroke-width="1.2" transform="rotate(${angle} ${round(cx)} ${round(cy)})"/>`;
}

/**
 * @param {unknown} definitions
 * @param {{changed?: Record<string, string>, title?: string}} [options]
 *   `changed` maps an element id to a change kind, which colours it.
 */
export function render(definitions, { changed = {}, title = '' } = {}) {
  const ir = project(definitions);
  const nodes = ir.nodes ?? [];
  const { shapes, labels, edges } = geometry(definitions);
  // Three layers, painted in this order: a container drawn after its contents would cover them.
  const behind = [];
  const between = [];
  const front = [];
  const messages = new Set((ir.messageFlows ?? []).map((flow) => flow.id));
  // A marker nothing points at is dead weight in every file that has no collaboration.
  let drawsMessages = false;

  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const extend = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  // A pool with no process behind it is a black box, and still has a body and a name.
  for (const pool of ir.pools ?? []) {
    const box = shapes.get(pool.id);
    if (!box) continue;
    extend(box.x, box.y);
    extend(box.x + box.width, box.y + box.height);
    behind.push(container(pool.id, 'pool', box, pool.name));
  }
  for (const lane of ir.lanes ?? []) {
    const box = shapes.get(lane.id);
    if (box) behind.push(container(lane.id, 'lane', box, lane.name));
  }

  // What a flow says about itself at its source: the branch taken when nothing matched, or the one
  // guarded by a condition. BPMN puts a tick on the first and a small diamond on the second.
  const defaults = new Set(
    (ir.nodes ?? []).map((node) => node.default).filter((value) => value !== undefined),
  );
  const conditional = new Set(
    (ir.flows ?? []).filter((flow) => flow.if !== undefined).map((flow) => flow.id),
  );
  const links = new Set((ir.links ?? []).map((link) => link.id));

  // A group is a background the flow sits on; a data object and a note sit alongside it.
  const draw = (layer, item, kind, text) => {
    const box = shapes.get(item.id);
    if (!box) return;
    extend(box.x, box.y);
    extend(box.x + box.width, box.y + box.height);
    layer.push(artifact(item.id, kind, box, text));
  };
  for (const group of ir.groups ?? []) draw(behind, group, 'group', group.name);
  for (const item of ir.data ?? []) draw(front, item, item.kind, item.name);
  for (const note of ir.notes ?? []) draw(front, note, 'note', note.text);

  for (const [id, points] of edges) {
    for (const [x, y] of points) extend(x, y);
    const colour = PALETTE[changed[id]];
    const message = messages.has(id);
    drawsMessages ||= message;
    if (links.has(id)) {
      between.push(
        `<polyline${tag(id, 'link')} points="${points.map(([x, y]) => `${x},${y}`).join(' ')}" ` +
          `fill="none" stroke="${colour ?? LINE}" stroke-width="1.2" stroke-dasharray="1 3"/>`,
      );
      continue;
    }
    between.push(
      `<polyline${tag(id, message ? 'message' : 'flow')} ` +
        `points="${points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" ` +
        `stroke="${colour ?? LINE}" stroke-width="${colour ? 2.5 : 1.2}" ` +
        (message
          ? `stroke-dasharray="6 4" marker-start="url(#message-start)" marker-end="url(#message-end)"/>`
          : `marker-end="url(#arrow)"/>`),
    );
    const kind = defaults.has(id) ? 'default' : conditional.has(id) ? 'conditional' : null;
    if (kind) between.push(flowMark(kind, points));
  }

  for (const element of nodes) {
    const box = shapes.get(element.id);
    if (!box) continue;
    extend(box.x, box.y);
    extend(box.x + box.width, box.y + box.height);
    front.push(node(element, box, PALETTE[changed[element.id]], changed[element.id]));
    if (!element.name) continue;
    const text = labelBox(element, box, labels.get(element.id));
    extend(text.x, text.y);
    extend(text.x + text.width, text.y + text.height);
    front.push(label(element.id, element.name, text));
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
    // A sequence flow ends in a solid head; a message flow starts at a hollow circle and ends in a
    // hollow head. That pair is how BPMN says "this crosses a pool boundary".
    `<defs>` +
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" ` +
    `orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${LINE}"/></marker>` +
    (drawsMessages
      ? `<marker id="message-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
        `markerHeight="7" orient="auto-start-reverse">` +
        `<path d="M0,1 L9,5 L0,9" fill="none" stroke="${LINE}"/></marker>` +
        `<marker id="message-start" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" ` +
        `markerHeight="6" orient="auto-start-reverse">` +
        `<circle cx="5" cy="5" r="4" fill="${GROUND}" stroke="${LINE}"/></marker>`
      : '') +
    `</defs>` +
    `<rect x="${minX - pad}" y="${top}" width="${width}" height="${height}" fill="${GROUND}"/>` +
    (title
      ? `<text x="${minX - pad + 12}" y="${top + 18}" font-size="12" fill="${LINE}">${escape(title)}</text>`
      : '') +
    behind.join('') +
    between.join('') +
    front.join('') +
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
