#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse, project, scoreAll } from '../../backend/core/index.mjs';
import { byId } from '../tasks/tasks.mjs';

// The free half. It reads what the paid half recorded and scores it: the gates and the task's own
// assertion, both deterministic. `npm run check` runs this, so a number in the README is
// reproducible by anyone with the repository and no API key at all.

// A directory can be passed so a test can score fabricated cells without touching real results.
const RUNS_ROOT = process.argv[2] ?? new URL('../runs/', import.meta.url).pathname;
const CORPUS = new URL('../corpus/', import.meta.url).pathname;

async function cells() {
  const found = [];
  const stamps = await readdir(RUNS_ROOT).catch(() => []);
  for (const stamp of stamps.filter((name) => !name.startsWith('.'))) {
    for (const task of await readdir(join(RUNS_ROOT, stamp))) {
      for (const arm of await readdir(join(RUNS_ROOT, stamp, task))) {
        for (const file of await readdir(join(RUNS_ROOT, stamp, task, arm))) {
          found.push({ stamp, path: join(RUNS_ROOT, stamp, task, arm, file) });
        }
      }
    }
  }
  return found;
}

async function score(cell) {
  const task = byId.get(cell.task);
  if (!task) return { ok: false, why: [`unknown task ${cell.task}`] };
  if (!cell.xml) return { ok: false, why: [cell.crash ? `crashed: ${cell.crash}` : 'produced no file'] };

  const beforeXml = await readFile(join(CORPUS, task.file), 'utf8');
  const before = project((await parse(beforeXml)).definitions);

  let after;
  try {
    after = project((await parse(cell.xml)).definitions);
  } catch (error) {
    return { ok: false, why: [`does not parse: ${error.message.slice(0, 80)}`] };
  }

  const { gates } = await scoreAll(beforeXml, cell.xml, {
    // The assertion decides whether the right thing was done; the collateral gate cannot know
    // which ids an arm was entitled to touch, so it is reported and not counted here.
    expectChangedIds: [],
  });
  const hard = ['parses', 'xsdValid', 'references', 'lintClean'].filter((name) => !gates[name].ok);

  let why;
  try {
    why = task.check(after, before);
  } catch (error) {
    why = [`assertion threw: ${error.message.slice(0, 80)}`];
  }

  return { ok: hard.length === 0 && why.length === 0, gates: hard, why, diff: gates.diffSanity };
}

const found = await cells();
if (!found.length) {
  process.stdout.write('no recorded runs under bench/runs — record some with: npm run bench:agent\n');
  process.exit(0);
}

const results = [];
for (const { path } of found) {
  const cell = JSON.parse(await readFile(path, 'utf8'));
  results.push({ ...cell, score: await score(cell) });
}

const arms = [...new Set(results.map((result) => result.arm))].sort();
const tasks = [...new Set(results.map((result) => result.task))].sort();
const pad = (value, width) => String(value).padEnd(width);

process.stdout.write(`\n${pad('task', 6)}${arms.map((arm) => pad(arm, 12)).join('')}\n`);
process.stdout.write('-'.repeat(6 + arms.length * 12) + '\n');

const totals = new Map(arms.map((arm) => [arm, { pass: 0, of: 0, cost: 0 }]));
for (const task of tasks) {
  const row = [pad(task, 6)];
  for (const arm of arms) {
    const cellsHere = results.filter((result) => result.task === task && result.arm === arm);
    const passed = cellsHere.filter((result) => result.score.ok).length;
    const tally = totals.get(arm);
    tally.pass += passed;
    tally.of += cellsHere.length;
    tally.cost += cellsHere.reduce((sum, result) => sum + (result.cost_usd ?? 0), 0);
    row.push(pad(cellsHere.length ? `${passed}/${cellsHere.length}` : '·', 12));
  }
  process.stdout.write(`${row.join('')}\n`);
}

process.stdout.write('-'.repeat(6 + arms.length * 12) + '\n');
process.stdout.write(
  pad('', 6) + arms.map((arm) => pad(`${totals.get(arm).pass}/${totals.get(arm).of}`, 12)).join('') + '\n',
);
process.stdout.write(
  pad('$', 6) + arms.map((arm) => pad(`$${totals.get(arm).cost.toFixed(2)}`, 12)).join('') + '\n',
);

const failures = results.filter((result) => !result.score.ok);
if (failures.length) {
  process.stdout.write('\nwhy each failing cell failed\n');
  for (const failure of failures.slice(0, 40)) {
    const reason = [...(failure.score.gates ?? []).map((gate) => `gate:${gate}`), ...(failure.score.why ?? [])];
    const line = reason.join('; ').replace(/\s+/g, ' ').trim();
    process.stdout.write(`  ${failure.task} ${pad(failure.arm, 9)}#${failure.run}  ${line.slice(0, 96)}\n`);
  }
}
process.stdout.write('\n');
