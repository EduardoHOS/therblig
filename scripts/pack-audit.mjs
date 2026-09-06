// What would actually ship.
//
// The repository root is both the benchmark harness and the published package, so the
// `files` allowlist is the only thing standing between npm and a 23-file BPMN corpus
// licensed CC BY 3.0. Two failure modes this catches, both silent until a user hits them:
//
//   - the OMG schemas missing from the tarball, which makes xsdValid's catch report
//     every file in the world as invalid;
//   - bench/ riding along, which would put CC BY 3.0 fixtures inside an Apache-2.0
//     package and add a megabyte nobody asked for.
import { execFileSync } from 'node:child_process';

const MUST = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'backend/cli/bin.mjs',
  'backend/mcp/bin.mjs',
  'backend/mcp/server.mjs',
  'backend/core/index.mjs',
  'backend/oracle/inspect.mjs',
  'backend/render/svg.mjs',
];
const MUST_MATCH = [[/^third_party\/omg\/.*\.xsd$/, 5]];
const MUST_NOT = [/^bench\//, /corpus/, /\.bpmn$/, /^backend\/test\//, /^scripts\//, /^plugin\//, /^docs\//];
const MAX_KB = 500;

// shell on win32 because `npm` there is npm.cmd, which execFileSync cannot spawn
// directly. Safe here: every argument is a fixed literal.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
});
const meta = JSON.parse(raw)[0];
const files = meta.files.map((file) => file.path);
const kb = meta.unpackedSize / 1024;

const problems = [];
for (const required of MUST) if (!files.includes(required)) problems.push(`missing ${required}`);
for (const [pattern, count] of MUST_MATCH) {
  const found = files.filter((file) => pattern.test(file)).length;
  if (found !== count) problems.push(`expected ${count} matching ${pattern}, found ${found}`);
}
for (const pattern of MUST_NOT) {
  const leaked = files.filter((file) => pattern.test(file));
  if (leaked.length) problems.push(`${leaked.length} file(s) matching ${pattern} would ship, e.g. ${leaked[0]}`);
}
if (kb > MAX_KB) problems.push(`unpacked ${kb.toFixed(0)}KB exceeds the ${MAX_KB}KB ceiling`);

// ADR-005: nothing published may depend on a layout engine that fails silently on 9 of
// the 21 MIWG reference models.
const declared = Object.keys(JSON.parse(
  execFileSync('npm', ['pkg', 'get', 'dependencies'], { encoding: 'utf8', shell: process.platform === 'win32' }),
));
for (const banned of ['bpmn-auto-layout', 'bpmnlint', 'bpmn-js', 'diagram-js']) {
  if (declared.includes(banned)) problems.push(`${banned} is a runtime dependency; ADR-005 and ADR-009 forbid it`);
}

console.log(`${meta.name}@${meta.version}: ${files.length} files, ${kb.toFixed(0)}KB`);
console.log(`  runtime dependencies: ${declared.join(', ')}`);
for (const problem of problems) console.log(`  FAIL ${problem}`);
if (!problems.length) console.log('  ok   contents as expected');
process.exit(problems.length ? 1 : 0);
