// What would actually ship.
//
// Two failure modes this catches, both silent until a user hits them:
//   - the OMG schemas not being in the tarball, which makes xsdValid's catch report
//     every file in the world as invalid;
//   - the 22-file corpus riding along, which would put CC BY 3.0 fixtures inside an
//     Apache-2.0 package and add a megabyte nobody asked for.
import { execFileSync } from 'node:child_process';

const EXPECT = {
  therblig: {
    must: ['src/cli/bin.mjs', 'src/mcp/bin.mjs', 'src/mcp/server.mjs', 'src/oracle/inspect.mjs', 'package.json'],
    mustMatch: [[/^third_party\/omg\/.*\.xsd$/, 5]],
    mustNot: [/corpus/, /\.bpmn$/, /^bench\//, /^test\//],
    maxKB: 400,
  },
  'therblig-mcp': {
    must: ['bin.mjs', 'package.json'],
    mustMatch: [],
    mustNot: [/\.bpmn$/, /^src\//],
    maxKB: 20,
  },
};

let failed = 0;
for (const [pkg, rules] of Object.entries(EXPECT)) {
  // shell on win32 because `npm` there is npm.cmd, which execFileSync cannot spawn
  // directly. Safe here: every argument is a fixed literal. The opposite call is made
  // in bench/probe/probe-comment-incidence.mjs, which must NOT use a shell, because
  // cmd.exe mangles the jq expression it passes. Both are deliberate.
  const raw = execFileSync('npm', ['pack', '--dry-run', '-w', pkg, '--json'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
  });
  const meta = JSON.parse(raw)[0];
  const files = meta.files.map((f) => f.path);
  const kb = meta.unpackedSize / 1024;
  const problems = [];

  for (const m of rules.must) if (!files.includes(m)) problems.push(`missing ${m}`);
  for (const [re, n] of rules.mustMatch) {
    const got = files.filter((f) => re.test(f)).length;
    if (got !== n) problems.push(`expected ${n} matching ${re}, found ${got}`);
  }
  for (const re of rules.mustNot) {
    const leaked = files.filter((f) => re.test(f));
    if (leaked.length) problems.push(`${leaked.length} file(s) matching ${re} would ship, e.g. ${leaked[0]}`);
  }
  if (kb > rules.maxKB) problems.push(`unpacked ${kb.toFixed(0)}KB exceeds the ${rules.maxKB}KB ceiling`);

  console.log(`${pkg}: ${files.length} files, ${kb.toFixed(0)}KB`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  if (!problems.length) console.log('  ok   contents as expected');
  failed += problems.length;
}

process.exit(failed ? 1 : 0);
