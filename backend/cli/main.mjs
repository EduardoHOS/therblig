#!/usr/bin/env node
import { parseArgs } from 'node:util';

import {
  diffSanity,
  lintClean,
  parses,
  project,
  propose,
  references,
  serialize,
  xsdValid,
} from '../core/index.mjs';
import { readBpmn, writeBpmnAtomic } from '../io/bpmn-file.mjs';
import { allowanceOf, envelopeFor } from './apply.mjs';
import { explain } from './explain.mjs';

const USAGE = `treadle — read, explain and edit the .bpmn files you already have

  treadle project <file> [--scope <id>]   the coordinate-free IR, as JSON
  treadle lint <file>                     run every gate; exit 1 if one fails
  treadle explain <file>                  a deterministic reading of the process
  treadle fmt <file> [--write]            the one-time normalisation, on its own
  treadle apply <file> --op <name> --args <json> [--write]
  treadle apply <file> --plan <file.json> [--write]

  --root <dir>    widen the workspace (default: the working directory)
  --allow <list>  risk levels this edit may reach (default: safe,additive)
  --write         publish the result; without it nothing touches the disk

Every edit is a dry run until --write, and every edit is refused if a gate fails.`;

const COMMANDS = ['project', 'lint', 'explain', 'fmt', 'apply'];
const OPTIONS = {
  scope: { type: 'string' },
  root: { type: 'string' },
  op: { type: 'string' },
  args: { type: 'string' },
  plan: { type: 'string' },
  allow: { type: 'string' },
  write: { type: 'boolean' },
};

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
  if (!command || !file || !COMMANDS.includes(command)) return fail(USAGE);

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

  if (command === 'lint') {
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

  // Normalisation is its own command so the one-time reformat lands in its own commit, instead of
  // hiding inside whatever edit happened to come first (ADR-004).
  if (command === 'fmt') {
    const normalised = await serialize(source.document);
    if (normalised === source.xml) {
      process.stdout.write('already normalised — +0 −0 lines\n');
      return undefined;
    }
    const { addedLines, removedLines } = diffSanity(source.xml, normalised);
    if (!parsed.values.write) {
      process.stdout.write(
        `would reformat: −${removedLines} +${addedLines} lines\npass --write, then read it with git diff\n`,
      );
      return undefined;
    }
    await writeBpmnAtomic(source.path, normalised, { root });
    process.stdout.write(`reformatted: −${removedLines} +${addedLines} lines\n`);
    return undefined;
  }

  let envelope;
  let allowance;
  try {
    allowance = allowanceOf(parsed.values.allow);
    envelope = await envelopeFor(parsed.values, {
      ir: project(source.document.definitions),
      root,
    });
  } catch (error) {
    return fail(error.code && error.code !== 'usage' ? `${error.code}: ${error.message}` : error.message);
  }

  const lines = [
    `op       ${envelope.op}`,
    `risk     ${envelope.risk}`,
    `explain  ${envelope.explain}`,
  ];
  if (!allowance.has(envelope.risk)) {
    process.stdout.write(`${lines.join('\n')}\n`);
    return fail(
      `Refusing a ${envelope.risk} edit: allowance is ${[...allowance].join(',')} — pass --allow ${envelope.risk}`,
      3,
    );
  }

  const result = await propose(source.document, envelope.plan);
  const { ok, text } = report(result.gates);
  lines.push(text);
  lines.push(
    `diff     −${result.diff.removedLines} +${result.diff.addedLines} lines, ` +
      `${result.diff.shapesMoved} of ${result.diff.shapesTotal} shapes moved` +
      `${result.diff.rigid ? '' : ' — REFLOWED'}`,
  );
  if (envelope.inverse) lines.push(`inverse  ${JSON.stringify(envelope.inverse)}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  if (!ok || !result.ok) {
    process.exitCode = 1;
    return undefined;
  }
  if (parsed.values.write) await writeBpmnAtomic(source.path, result.xml, { root });
  return undefined;
}

await main(process.argv.slice(2));
