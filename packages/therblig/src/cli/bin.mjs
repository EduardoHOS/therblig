#!/usr/bin/env node
// therblig — read, explain, lint and edit the .bpmn files already in your repo.
import { readFileSync } from 'node:fs';
import { TherbligError } from '../errors.mjs';
import { expand, cmdRead, cmdExplain, cmdLint, cmdVerify, cmdFmt, cmdPatch, cmdVerifyReceipt } from './commands.mjs';

const USAGE = `therblig — BPMN 2.0, from the command line.

  therblig read    <file|dir>...     the compact projection, and the file's revision
  therblig explain <file|dir>...     counts, complexity and a Mermaid diagram
  therblig lint    <file|dir>...     what is wrong, and the rule it breaks
  therblig verify  <file|dir>...     does it parse and match the OMG schemas
  therblig fmt     <file|dir>... --check   what normalising would cost
  therblig patch   <file> --ops <file.json> [--receipt]     preview the edit
  therblig patch   <file> --ops <file.json> --write --base-rev <rev> [--receipt]
  therblig verify  --receipt <r.json> <before> <after>      re-derive a receipt

  --json      machine-readable output
  --version   print the version

Editing previews by default. --write also needs --base-rev, the revision "read" printed,
so an edit built against stale bytes is refused instead of overwriting a modeller save.`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const json = flags.has('--json');

async function main() {
  if (flags.has('--version')) {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  const [cmd, ...rest] = positional;
  if (!cmd || flags.has('--help') || cmd === 'help') { console.log(USAGE); return cmd ? 0 : 1; }

  // `--ops <path>` puts a filename in the positional list; keep it out of the targets.
  const opsPath = valueOf('--ops');
  const targets = rest.filter((t) => t !== opsPath);
  if (cmd !== 'patch' && !targets.length) { console.log(USAGE); return 1; }

  switch (cmd) {
    case 'read': return cmdRead(expand(targets), { json });
    case 'explain': return cmdExplain(expand(targets), { json });
    case 'lint': return cmdLint(expand(targets), { json });
    case 'verify': {
      // `verify --receipt r.json before.bpmn after.bpmn` re-derives a receipt's numbers.
      // `verify <files>` checks the schemas. Same verb, because both answer "is this
      // claim about the file true".
      const receiptPath = valueOf('--receipt');
      if (receiptPath) {
        const pair = targets.filter((t) => t !== receiptPath);
        if (pair.length !== 2) {
          console.log('therblig verify --receipt r.json before.bpmn after.bpmn');
          return 1;
        }
        return cmdVerifyReceipt(receiptPath, pair[0], pair[1], { json });
      }
      return cmdVerify(expand(targets), { json });
    }
    case 'fmt': return cmdFmt(expand(targets), { json, write: flags.has('--write') });
    case 'patch': {
      const baseRev = valueOf('--base-rev');
      const file = targets.filter((t) => t !== baseRev)[0];
      if (!file) { console.log('therblig patch needs a file. See therblig --help.'); return 1; }
      if (!opsPath) { console.log('therblig patch needs --ops <file.json>. See therblig --help.'); return 1; }
      const write = flags.has('--write');
      if (write && !baseRev) {
        console.log('Writing needs --base-rev, the revision therblig read printed. Read the file again to get it.');
        return 1;
      }
      const ops = JSON.parse(readFileSync(opsPath, 'utf8'));
      return cmdPatch(file, Array.isArray(ops) ? ops : [ops], { json, write, baseRev, receipt: flags.has('--receipt') });
    }
    default:
      console.log(`Unknown command "${cmd}".\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  // Errors go to stderr, always. stdout is reserved for the answer, so that piping
  // `therblig read --json` into another tool never mixes a diagnostic into the JSON.
  if (e instanceof TherbligError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
