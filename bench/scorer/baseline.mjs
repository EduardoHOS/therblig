// Establishes the corpus floor: do the OMG reference models themselves pass our gates?
// If a MIWG reference file fails XSD or lint, the gate is too strict (or the file is
// genuinely non-conformant) — either way we must know before scoring any arm against it.
import { parses, xsdValid, lintClean } from './gates.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
function walk(d, o = []) { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p, o) : extname(p) === '.bpmn' && o.push(p); } return o; }
const p = (s, n) => String(s ?? '').padEnd(n);
console.log(p('file', 30) + p('parse', 8) + p('xsd', 8) + p('lint', 8) + 'lint errors');
console.log('-'.repeat(90));
let px = 0, xx = 0, lx = 0, n = 0;
for (const f of walk(process.argv[2] || 'bench/corpus')) {
  const xml = readFileSync(f, 'utf8'); const short = f.split(sep).join('/').replace('bench/corpus/', ''); n++;
  const a = await parses(xml); const b = await xsdValid(xml); const c = await lintClean(xml, { config: { extends: 'bpmnlint:recommended' } });
  if (a.ok) px++; if (b.ok) xx++; if (c.ok) lx++;
  const errs = (c.errors || []).slice(0, 3).map(e => e.rule).join(',');
  console.log(p(short, 30) + p(a.ok ? 'ok' : 'FAIL', 8) + p(b.ok ? 'ok' : 'FAIL', 8) + p(c.ok ? 'ok' : (c.errors.length + ' err'), 8) + errs);
  if (!b.ok) console.log('    xsd:', (b.errors[0] || '').slice(0, 130));
}
console.log(`\n${n} files | parse ${px}/${n} | xsd ${xx}/${n} | lint-clean ${lx}/${n}`);

// Parse and XSD are absolute invariants of the corpus (F2, F7: 22/22 both). If either
// regresses, a dependency changed under us or a fixture was edited in place. Lint under
// `recommended` is 9/22 BY DESIGN and must never fail the build — F5 is precisely the
// finding that the OMG's own reference models violate it 59% of the time, which is why
// ADR-006 makes recommended a differential gate rather than an absolute one.
//
// Until this ran with an exit code, the CI job invoking it could not fail. It was
// decorative from the first commit.
const broken = (px < n ? 1 : 0) + (xx < n ? 1 : 0);
if (broken) {
  console.log(`\nFAIL: parse ${px}/${n} and xsd ${xx}/${n} must both be ${n}/${n}.`);
  process.exit(1);
}
console.log(`(lint-clean ${lx}/${n} is expected and not a failure — see FINDINGS.md F5.)`);
