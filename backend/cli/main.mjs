#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { lintClean, parses, project, references, xsdValid } from '../core/index.mjs';
import { readBpmn } from '../io/bpmn-file.mjs';
import { explain } from './explain.mjs';

const USAGE = `treadle — read, explain and lint the .bpmn files you already have

  treadle project <file> [--scope <id>]   the coordinate-free IR, as JSON
  treadle lint <file>                     run every gate; exit 1 if one fails
  treadle explain <file>                  a deterministic reading of the process

  --root <dir>   widen the workspace (default: the working directory)

Nothing here writes.`;

const OPTIONS = { scope: { type: 'string' }, root: { type: 'string' } };

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

// One line per gate, so a failure is readable without reaching for a JSON parser.
function report(gates) {
  const lines = [];
  let ok = true;
  for (const [name, gate] of Object.entries(gates)) {
    ok &&= gate.ok;
    lines.push(`${gate.ok ? 'ok  ' : 'fail'} ${name}`);
    for (const finding of gate.findings ?? gate.errors ?? []) {
      lines.push(`       ${typeof finding === 'string' ? finding : Object.values(finding).join(' ')}`);
    }
  }
  return { ok, text: lines.join('\n') };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    return fail(`${error.message}\n\n${USAGE}`);
  }

  const [command, file] = parsed.positionals;
  if (!command || !file || !['project', 'lint', 'explain'].includes(command)) {
    return fail(USAGE);
  }

  const root = parsed.values.root ?? process.cwd();
  let source;
  try {
    source = await readBpmn(file, { root });
  } catch (error) {
    const hint = error.code === 'path-outside-root' ? ' — pass --root to widen it' : '';
    return fail(`${error.message}${hint}`);
  }

  if (command === 'project') {
    const ir = project(source.document.definitions, { scope: parsed.values.scope });
    process.stdout.write(`${JSON.stringify(ir, null, 2)}\n`);
    return undefined;
  }

  if (command === 'explain') {
    process.stdout.write(`${explain(file, project(source.document.definitions))}\n`);
    return undefined;
  }

  const gates = {
    parses: await parses(source.xml),
    xsdValid: await xsdValid(source.xml),
    references: await references(source.xml),
    lintClean: await lintClean(source.xml, { config: { extends: 'bpmnlint:correctness' } }),
  };
  const { ok, text } = report(gates);
  process.stdout.write(`${text}\n`);
  if (!ok) process.exitCode = 1;
  return undefined;
}

await main(process.argv.slice(2));
