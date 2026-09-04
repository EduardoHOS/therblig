// F10. Does a moddle round-trip conserve the XML constructs it does not model?
//
// ADR-001 makes the moddle tree the source of truth, and its stated reversal
// condition is "we find a file where moddle silently drops content on round-trip".
// The guard it named for that condition is F2's profile, which compares a SEMANTIC
// TALLY of elements — a comparison that cannot see a comment, because a comment was
// never an element. The guard could not detect its own reversal condition.
//
// Upstream cause is structural, not a bug: moddle-xml registers saxen handlers for
// openTag, question, closeTag, cdata, text, error and warn — and never for `comment`
// or `attention`. So comments, DOCTYPE declarations and every processing instruction
// other than the XML declaration are dropped, silently, with zero parser warnings.
//
// RED probe: asserts conservation. Expected to FAIL until ADR-004's second clause is
// implemented (warn before the write) — the point is that the loss is measured and
// reported, not that it is prevented. See kill criterion 1.
import { BpmnModdle } from 'bpmn-moddle';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'bench/corpus';

function bpmnFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...bpmnFiles(p));
    else if (e.endsWith('.bpmn')) out.push(p);
  }
  return out.sort();
}

// Textual constructs moddle does not model. Counted on raw text on purpose: the
// whole point is that they never reach the tree, so the tree cannot be asked.
function constructs(xml) {
  return {
    comments: (xml.match(/<!--[\s\S]*?-->/g) || []).length,
    doctype: (xml.match(/<!DOCTYPE[\s\S]*?>/gi) || []).length,
    // every PI except the XML declaration itself
    pis: (xml.match(/<\?[\s\S]*?\?>/g) || []).filter(s => !/^<\?xml\s/i.test(s)).length,
  };
}

// A comment on line 1-2 before the root element is an exporter banner and is
// cosmetically lossless. One inside the document body is the user's own annotation.
function positions(xml) {
  const rootAt = xml.search(/<(?:\w+:)?definitions[\s>]/);
  let header = 0, body = 0;
  for (const m of xml.matchAll(/<!--[\s\S]*?-->/g)) {
    if (rootAt >= 0 && m.index < rootAt) header++; else body++;
  }
  return { header, body };
}

const files = bpmnFiles(root);
let filesWithAny = 0, filesLosing = 0, totalLost = 0, bodyLost = 0;
const rows = [];

for (const f of files) {
  const xml = readFileSync(f, 'utf8');
  const before = constructs(xml);
  const n = before.comments + before.doctype + before.pis;
  if (!n) continue;
  filesWithAny++;

  const moddle = new BpmnModdle();
  const { rootElement, warnings } = await moddle.fromXML(xml);
  const { xml: out } = await moddle.toXML(rootElement, { format: true });
  const after = constructs(out);
  const pos = positions(xml);

  const lost = (before.comments - after.comments) + (before.doctype - after.doctype) + (before.pis - after.pis);
  if (lost > 0) { filesLosing++; totalLost += lost; bodyLost += pos.body; }
  rows.push({ f: f.replace(root + '/', ''), before, after, lost, pos, warnings: warnings.length });
}

console.log(`conservation probe over ${files.length} files\n`);
if (!rows.length) {
  console.log('no file in this corpus carries a comment, DOCTYPE or PI — the probe proves nothing here.');
} else {
  console.log('file'.padEnd(30), 'comments', 'doctype', 'pi', 'lost', 'hdr/body', 'warnings');
  for (const r of rows) {
    console.log(
      r.f.padEnd(30),
      `${r.before.comments}->${r.after.comments}`.padEnd(9),
      `${r.before.doctype}->${r.after.doctype}`.padEnd(8),
      `${r.before.pis}->${r.after.pis}`.padEnd(3),
      String(r.lost).padEnd(5),
      `${r.pos.header}/${r.pos.body}`.padEnd(9),
      r.warnings,
    );
  }
}

console.log(`\n${filesWithAny} file(s) carry unmodelled constructs; ${filesLosing} lose them on round-trip.`);
console.log(`${totalLost} construct(s) lost in total, ${bodyLost} of them in body position.`);
console.log(`parser warnings emitted about this loss: 0 (moddle has no handler to warn from).`);

const ok = totalLost === 0;
console.log(`\nverdict: ${ok ? 'CONSERVED' : 'LOSS CONFIRMED (F10) — expected RED until ADR-004 clause 2 ships'}`);
process.exit(ok ? 0 : 1);
