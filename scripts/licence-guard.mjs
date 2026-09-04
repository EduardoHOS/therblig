// ADR-009, enforced over what is actually installed rather than over a list of names.
//
// The rationale the ADR originally gave was wrong: the bpmn.io licence names no
// packages at all. It grants MIT-like terms "except that the source code responsible
// for displaying the bpmn.io project watermark ... MUST NOT be removed or changed".
// The obligation travels with the WATERMARK, not with four package names.
//
// The name loop this replaces was broken in both directions:
//   false positive — unscoped `form-js` on npm is an unrelated MIT package, so any
//                    install of it failed the build for no reason;
//   false negative — @bpmn-io/form-js{,-viewer,-editor,-carbon-styles} and
//                    dmn-js-{drd,decision-table,literal-expression,shared} all carry
//                    the clause and were never checked. Eight ways to pass while
//                    shipping the obligation. Verified 2026-09-04: installing
//                    @bpmn-io/form-js-viewer passed the old check and fails this one.
//
// Two mechanical checks, no name matching:
//   1. every production package resolves to an SPDX expression on the allowlist
//   2. no shipped licence text mentions a watermark
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ALLOW = new Set([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
  '0BSD', 'Unlicense', 'CC0-1.0', 'MIT-0', 'BlueOak-1.0.0',
]);

// Dated, justified, re-checked on every dependency bump. An entry here is a human
// decision on the record, not a silenced warning.
const EXCEPTIONS = {
  'cli-table@0.3.11':
    'declares no "license" field; ships LICENSE with verbatim MIT text ' +
    '(Copyright (c) 2010 LearnBoost). Reviewed 2026-09-04. Transitive via bpmnlint.',
};

// Permitted despite living under the bpmn.io org: verified MIT, no watermark, and no
// dependency on bpmn-js. It already separates _layoutChanged from
// _added/_removed/_changed, which is exactly the split the M4 receipt needs.
const EXPLICIT_ALLOW = new Set(['bpmn-js-differ']);

// Denied regardless of what it declares. Its LICENSE.md is "(c) Anthropic PBC. All
// rights reserved" — strictly more restrictive than the watermark clause this guard
// exists to exclude. Treadle never needs it: the product IS an MCP server.
const DENY = new Set(['@anthropic-ai/claude-agent-sdk']);

// A disjunction — "(MPL-2.0 OR Apache-2.0)" — lets the consumer choose, so one
// allowed disjunct suffices. A conjunction must satisfy every term. Anything else,
// "SEE LICENSE IN ..." included, fails closed and needs a human on the record.
function satisfies(expr) {
  const e = expr.trim().replace(/^\(/, '').replace(/\)$/, '').trim();
  if (ALLOW.has(e)) return true;
  if (/\sAND\s/i.test(e)) return e.split(/\sAND\s/i).every((t) => satisfies(t));
  if (/\sOR\s/i.test(e)) return e.split(/\sOR\s/i).some((t) => satisfies(t));
  return false;
}

function productionDirs() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    encoding: 'utf8', shell: process.platform === 'win32',
  });
  return out.split(/\r?\n/).filter(Boolean);
}

function spdxOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && pkg.license.type) return pkg.license.type;      // legacy object
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ');
  return null;
}

function licenceTexts(dir) {
  const hits = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return hits; }
  for (const n of names) {
    if (!/^(LICEN[CS]E|COPYING|NOTICE)/i.test(n)) continue;
    try { hits.push([n, readFileSync(join(dir, n), 'utf8')]); } catch { /* unreadable */ }
  }
  return hits;
}

const failures = [];
const noted = [];
let checked = 0;

for (const dir of productionDirs()) {
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  if (!pkg.name || pkg.private) continue;                            // the workspace root
  checked++;
  const id = `${pkg.name}@${pkg.version}`;

  if (DENY.has(pkg.name)) { failures.push(`${id}  DENIED by policy`); continue; }

  const spdx = spdxOf(pkg);
  const allowed = (spdx && satisfies(spdx)) || EXPLICIT_ALLOW.has(pkg.name);
  if (!allowed) {
    if (EXCEPTIONS[id]) noted.push(`${id}  ${spdx ?? 'no license field'} — exception: ${EXCEPTIONS[id]}`);
    else failures.push(`${id}  license ${spdx ? `"${spdx}"` : 'ABSENT'} is not on the allowlist`);
  }

  for (const [name, text] of licenceTexts(dir)) {
    if (/watermark/i.test(text)) failures.push(`${id}  ${name} mentions a watermark obligation`);
  }
}

console.log(`licence guard: ${checked} production package(s) checked`);
for (const n of noted) console.log(`  note  ${n}`);
if (!failures.length) { console.log('  all clear'); process.exit(0); }
console.log('\nFAILURES:');
for (const f of failures) console.log(`  ${f}`);
console.log('\nAdd a dated EXCEPTIONS entry only with a reason a reviewer can check.');
process.exit(1);
