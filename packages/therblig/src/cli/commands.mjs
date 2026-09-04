// The six commands. One module rather than six files of twenty lines: they share
// argument handling and output voice, and splitting them would be ceremony.
//
// Voice, from the brand brief: say what happened, then what to do. Numbers over
// adjectives. Sentence case, one period. No exclamation marks.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse, serialize } from '../model.mjs';
import { project } from '../ir.mjs';
import { explain as explainDoc } from '../explain.mjs';
import { parses, xsdValid } from '../validate.mjs';
import { inspect } from '../oracle/inspect.mjs';
import { compare, blocking } from '../oracle/compare.mjs';
import { message } from '../oracle/invariants.mjs';
import { applyPatch } from '../patch.mjs';
import { placeNew } from '../place.mjs';
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
 * patch --dry-run — apply ops in memory, guard the result, print what would change.
 * v0.1 never writes. The barrier runs on the preview so its calibration is measured
 * before anything is at stake.
 */
export async function cmdPatch(file, ops, { json }) {
  const { xml, rev } = await readWithRev(file);
  const doc = await parse(xml);
  const { changed, created } = applyPatch(doc, ops);
  const touched = [...new Set([...changed, ...created])];
  placeNew(doc, touched);
  const after = await serialize(doc);

  const diags = await compare(xml, after, { expectedIds: touched });
  const blockers = blocking(diags);
  const result = {
    file: rel(file), base_rev: rev, dry_run: true,
    created, changed,
    refused: blockers.length > 0,
    diagnostics: diags.map((d) => ({ ...d, message: message(d) })),
  };
  if (json) { console.log(JSON.stringify(result, null, 2)); return blockers.length ? 1 : 0; }

  console.log(`${rel(file)}  ${rev}`);
  console.log(`  ${created.length} created, ${changed.length} changed. Nothing written.`);
  for (const d of diags) console.log(`  ${d.severity === 'error' ? 'error  ' : 'warning'}  ${message(d)}`);
  console.log(blockers.length
    ? `\nRefused. ${blockers.length} change${blockers.length === 1 ? '' : 's'} outside what you asked for.`
    : '\nSafe to apply. Writing arrives in the next version.');
  return blockers.length ? 1 : 0;
}
