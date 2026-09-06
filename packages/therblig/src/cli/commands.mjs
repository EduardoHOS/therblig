// The six commands. One module rather than six files of twenty lines: they share
// argument handling and output voice, and splitting them would be ceremony.
//
// Voice, from the brand brief: say what happened, then what to do. Numbers over
// adjectives. Sentence case, one period. No exclamation marks.
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse, serialize } from '../model.mjs';
import { project } from '../ir.mjs';
import { explain as explainDoc } from '../explain.mjs';
import { parses, xsdValid } from '../validate.mjs';
import { inspect } from '../oracle/inspect.mjs';
import { applyToFile } from '../write.mjs';
import { buildReceipt, verifyReceipt, renderDiff } from '../receipt.mjs';
import { message } from '../oracle/invariants.mjs';
import { readWithRev } from '../rev.mjs';
import { TherbligError } from '../errors.mjs';

const rel = (f) => f.split(sep).join('/');

export function expand(targets) {
  const files = [];
  for (const t of targets) {
    if (!existsSync(t)) throw new TherbligError('THB_NOT_FOUND', `${t} was not found.`);
    if (statSync(t).isDirectory()) {
      (function walkDir(d) {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          statSync(p).isDirectory() ? walkDir(p) : e.endsWith('.bpmn') && files.push(p);
        }
      })(t);
    } else files.push(t);
  }
  return files.sort();
}

/** read — the compact projection a model should reason over, plus its revision. */
export async function cmdRead(files, { json }) {
  for (const f of files) {
    const { xml, rev } = await readWithRev(f);
    const { definitions } = await parse(xml);
    const ir = project(definitions);
    if (json) { console.log(JSON.stringify({ file: rel(f), base_rev: rev, ir }, null, 2)); continue; }
    console.log(`${rel(f)}  ${rev}`);
    for (const p of ir.pools || []) console.log(`  pool  ${p.name ?? p.id}`);
    for (const n of ir.nodes || []) console.log(`  ${n.type.padEnd(11)} ${n.name ?? '·'}  ${n.id}`);
  }
  return 0;
}

/** explain — Mermaid, counts, and one complexity number. */
export async function cmdExplain(files, { json }) {
  for (const f of files) {
    const { xml } = await readWithRev(f);
    const r = await explainDoc(xml);
    if (json) { console.log(JSON.stringify({ file: rel(f), ...r, ir: undefined }, null, 2)); continue; }
    console.log(`\n${rel(f)}`);
    console.log(`  ${r.headline}. Control-flow complexity ${r.summary.cfc}.`);
    if (r.diagram.truncated) console.log(`  Diagram shows the first ${r.diagram.shown} nodes.`);
    console.log('\n```mermaid');
    console.log(r.diagram.text);
    console.log('```');
  }
  return 0;
}

/** lint — the oracle, in the product voice. */
export async function cmdLint(files, { json }) {
  let errors = 0, warnings = 0;
  const all = [];
  for (const f of files) {
    const { xml } = await readWithRev(f);
    const d = await inspect(xml);
    for (const x of d) (x.severity === 'error' ? errors++ : warnings++);
    if (json) { all.push({ file: rel(f), diagnostics: d.map((x) => ({ ...x, message: message(x) })) }); continue; }
    if (!d.length) continue;
    console.log(`\n${rel(f)}`);
    for (const x of d) console.log(`  ${x.severity === 'error' ? 'error  ' : 'warning'}  ${message(x)}`);
  }
  if (json) { console.log(JSON.stringify(all, null, 2)); return errors ? 1 : 0; }
  console.log(errors || warnings
    ? `\n${files.length} file${files.length === 1 ? '' : 's'}. ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`
    : `\nValid. ${files.length} file${files.length === 1 ? '' : 's'}, 0 errors, 0 warnings.`);
  return errors ? 1 : 0;
}

/** verify — does the file still parse and validate against the OMG schemas? */
export async function cmdVerify(files, { json }) {
  let bad = 0;
  const rows = [];
  for (const f of files) {
    const { xml } = await readWithRev(f);
    const p = await parses(xml);
    const x = p.ok ? await xsdValid(xml) : { ok: false, errors: [p.error] };
    if (!p.ok || !x.ok) bad++;
    rows.push({ file: rel(f), parses: p.ok, xsd: x.ok, errors: x.errors ?? [] });
    if (!json) {
      console.log(`  ${p.ok && x.ok ? 'ok   ' : 'FAIL '} ${rel(f)}${x.ok ? '' : '  ' + (x.errors[0] ?? '').slice(0, 100)}`);
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else console.log(bad
    ? `\n${files.length} files. ${bad} did not validate.`
    : `\nValid. ${files.length} file${files.length === 1 ? '' : 's'} ${files.length === 1 ? 'parses' : 'parse'} and ${files.length === 1 ? 'matches' : 'match'} the OMG schemas.`);
  return bad ? 1 : 0;
}

/**
 * fmt --check — what normalising this file would cost, without writing it.
 *
 * ADR-004's bargain, stated before it is taken: the first edit reformats the file, and
 * it also drops XML comments, DOCTYPE and processing instructions (F10). Writing is a
 * separate command that does not exist yet, on purpose.
 */
export async function cmdFmt(files, { json, write }) {
  if (write) throw new TherbligError('THB_WRITE_DISABLED', 'therblig fmt does not write yet.');
  const rows = [];
  for (const f of files) {
    const { xml } = await readWithRev(f);
    const doc = await parse(xml);
    const out = await serialize(doc);
    const before = xml.split('\n').length, after = out.split('\n').length;
    const comments = (xml.match(/<!--[\s\S]*?-->/g) || []).length;
    const identical = out.trim() === xml.trim();
    rows.push({ file: rel(f), identical, lines: [before, after], commentsLost: comments });
    if (!json) {
      console.log(identical
        ? `  ${rel(f)} is already normalised.`
        : `  ${rel(f)} would be reformatted, ${before} lines to ${after}.${comments ? ` ${comments} comment${comments === 1 ? '' : 's'} would be dropped.` : ''}`);
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  return 0;
}

/**
 * patch — apply ops, guard the result, and write only if the guard passes.
 *
 * Without --write this previews and returns. With --write it also requires --base-rev,
 * so an edit built against bytes that have since changed on disk is refused rather
 * than silently overwriting whatever a modeller saved in the meantime.
 */
export async function cmdPatch(file, ops, { json, write, baseRev, receipt }) {
  const r = await applyToFile(file, ops, { baseRev, dryRun: !write });
  const blockers = r.diagnostics.filter((d) => d.severity === 'error');
  const rec = await buildReceipt(r.before_xml, r.after_xml, {
    file: rel(file), ops, declared: r.declared, written: r.written, refused: r.refused,
  });

  // The receipt and the drawing are written next to the file they describe, so a commit
  // can carry the proof alongside the change it justifies.
  const artifacts = [];
  if (receipt) {
    const stem = file.replace(/\.bpmn$/i, '');
    writeFileSync(`${stem}.receipt.json`, JSON.stringify(rec, null, 2) + '\n');
    artifacts.push(`${stem}.receipt.json`);
    const svg = await renderDiff(r.before_xml, r.after_xml, {
      title: `${rel(file)} · ${rec.headline.split(' · ')[0]}`,
      flagged: blockers.flatMap((d) => d.elements),
    });
    writeFileSync(`${stem}.diff.svg`, svg);
    artifacts.push(`${stem}.diff.svg`);
  }

  if (json) {
    console.log(JSON.stringify({
      file: rel(file), base_rev: r.base_rev, new_rev: r.new_rev ?? null,
      written: r.written, refused: r.refused,
      created: r.created, changed: r.changed,
      receipt: rec, artifacts,
      diagnostics: r.diagnostics.map((d) => ({ ...d, message: message(d) })),
    }, null, 2));
    return r.refused ? 1 : 0;
  }

  console.log(`${rel(file)}  ${r.base_rev}`);
  console.log(`  ${rec.headline}`);
  const L = rec.diff.layout;
  console.log(`  ${L.shapesMoved} of ${L.shapesTotal} shapes moved, ${L.distinctDeltas} distinct delta${L.distinctDeltas === 1 ? '' : 's'}, ${L.labelsDetached} labels detached.`);
  for (const d of r.diagnostics) console.log(`  ${d.severity === 'error' ? 'error  ' : 'warning'}  ${message(d)}`);
  for (const a of artifacts) console.log(`  wrote ${rel(a)}`);
  if (r.refused) {
    console.log(`\nRefused. ${blockers.length} change${blockers.length === 1 ? '' : 's'} outside what you asked for. Nothing was written.`);
  } else if (r.written) {
    console.log(`\nWritten. ${r.base_rev} → ${r.new_rev}.`);
  } else {
    console.log('\nSafe to apply. Nothing written — add --write and pass --base-rev.');
  }
  return r.refused ? 1 : 0;
}

/**
 * verify --receipt — re-derive every number in a receipt from the two files.
 *
 * No network, no key, no trust in whoever produced it. A signature would prove therblig
 * wrote the receipt; re-derivation proves it is true, which is the useful half.
 */
export async function cmdVerifyReceipt(receiptPath, beforePath, afterPath, { json }) {
  const rec = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const beforeXml = readFileSync(beforePath, 'utf8');
  const afterXml = readFileSync(afterPath, 'utf8');
  const v = await verifyReceipt(rec, beforeXml, afterXml);
  if (json) { console.log(JSON.stringify(v, null, 2)); return v.ok ? 0 : 1; }
  if (v.ok) {
    console.log(`Receipt holds. ${v.checked} claims re-derived from the two files.`);
    console.log(`  ${rec.headline}`);
  } else {
    console.log(`Receipt does not match the files. ${v.problems.length} claim${v.problems.length === 1 ? ' disagrees' : 's disagree'}.`);
    for (const p of v.problems) console.log(`  ${p}`);
  }
  return v.ok ? 0 : 1;
}
