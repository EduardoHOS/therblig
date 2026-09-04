#!/usr/bin/env node
// therblig — read, explain, lint and edit the .bpmn files already in your repo.
import { readFileSync } from 'node:fs';
import { TherbligError } from '../errors.mjs';
import { expand, cmdRead, cmdExplain, cmdLint, cmdVerify, cmdFmt, cmdPatch } from './commands.mjs';

const USAGE = `therblig — BPMN 2.0, from the command line.

  therblig read    <file|dir>...     the compact projection, and the file's revision
  therblig explain <file|dir>...     counts, complexity and a Mermaid diagram
  therblig lint    <file|dir>...     what is wrong, and the rule it breaks
  therblig verify  <file|dir>...     does it parse and match the OMG schemas
  therblig fmt     <file|dir>... --check   what normalising would cost
  therblig patch   <file> --ops <file.json> --dry-run

  --json      machine-readable output
  --version   print the version

Editing is previewed but not written in this version. Pass --dry-run and read the diff.`;

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
    case 'verify': return cmdVerify(expand(targets), { json });
    case 'fmt': return cmdFmt(expand(targets), { json, write: flags.has('--write') });
    case 'patch': {
      const [file] = targets;
      if (!file) { console.log('therblig patch needs a file. See therblig --help.'); return 1; }
      if (!opsPath) { console.log('therblig patch needs --ops <file.json>. See therblig --help.'); return 1; }
      if (!flags.has('--dry-run')) {
        console.log('This version previews edits but does not write them. Add --dry-run to see the diff.');
        return 1;
      }
      const ops = JSON.parse(readFileSync(opsPath, 'utf8'));
      return cmdPatch(file, Array.isArray(ops) ? ops : [ops], { json });
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
