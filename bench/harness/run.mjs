#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { arms, armNames } from './arms.mjs';
import { byId, tasks } from '../tasks/tasks.mjs';
import { treadleServer } from './tools.mjs';

// The paid half of the bench. It calls the API, records everything it did, and never scores:
// scoring is replay.mjs's job, offline, so a number in the README can be reproduced by someone
// who has no key. Nothing here runs from `npm run check`.

const RUNS_ROOT = new URL('../runs/', import.meta.url).pathname;
const CORPUS = new URL('../corpus/', import.meta.url).pathname;
const SDK_VERSION = JSON.parse(
  await readFile(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'),
).version;

const BRIEF = `You are editing a BPMN 2.0 process file. Make exactly the change described and
nothing else — no tidying, no renaming things you were not asked about, no reformatting.
Preserve every element id that already exists. When the change is made, stop and say what you did.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function runCell({ task, arm, index, model, effort, budget, stamp }) {
  const cwd = await mkdtemp(join(tmpdir(), 'treadle-cell-'));
  const file = basename(task.file);
  await cp(join(CORPUS, task.file), join(cwd, file));

  const calls = [];
  const record = async (input, toolUseID) => {
    calls.push({
      at: Date.now(),
      event: input.hook_event_name,
      tool: input.tool_name,
      input: input.tool_input,
      toolUseID,
    });
    return {};
  };

  let result;
  let crash = null;
  try {
    for await (const message of query({
      prompt: `${task.prompt}\n\nThe file is ${file}, in this directory.`,
      options: {
        cwd,
        model,
        effort,
        maxTurns: 40,
        maxBudgetUsd: budget,
        // Nothing from the developer's own machine may leak into a cell: no CLAUDE.md, no
        // project skills, no settings. Every arm starts from the same empty context.
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: BRIEF },
        mcpServers: { treadle: treadleServer({ root: cwd, autonomous: new Set(['safe', 'additive', 'routing', 'destructive']) }) },
        ...arms[arm],
        hooks: {
          PreToolUse: [{ hooks: [record] }],
          PostToolUse: [{ hooks: [record] }],
        },
      },
    })) {
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    crash = error.message;
  }

  const produced = await readFile(join(cwd, file), 'utf8').catch(() => null);
  const cell = {
    task: task.id,
    arm,
    run: index,
    file: task.file,
    prompt: task.prompt,
    model,
    effort,
    sdk: SDK_VERSION,
    subtype: result?.subtype ?? 'no-result',
    crash,
    cost_usd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    session: result?.session_id ?? null,
    calls,
    xml: produced,
  };

  const directory = join(RUNS_ROOT, stamp, task.id, arm);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${index}.json`), `${JSON.stringify(cell, null, 1)}\n`);
  return cell;
}

const { values } = parseArgs({
  options: {
    tasks: { type: 'string' },
    arms: { type: 'string' },
    runs: { type: 'string', default: '1' },
    model: { type: 'string', default: 'claude-opus-5' },
    effort: { type: 'string', default: 'high' },
    yes: { type: 'boolean', default: false },
  },
});

if (!process.env.ANTHROPIC_API_KEY) {
  fail('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');
}
const budget = Number(process.env.TREADLE_BENCH_BUDGET_USD);
if (!(budget > 0)) {
  fail('TREADLE_BENCH_BUDGET_USD must be a positive number — this run spends real money.');
}

const chosen = values.tasks ? values.tasks.split(',').map((id) => byId.get(id.trim())) : tasks;
if (chosen.some((task) => !task)) fail(`Unknown task in --tasks ${values.tasks}`);
const chosenArms = values.arms ? values.arms.split(',').map((name) => name.trim()) : armNames;
if (chosenArms.some((name) => !arms[name])) fail(`Unknown arm in --arms ${values.arms}`);
const runs = Number(values.runs);

const cells = chosen.length * chosenArms.length * runs;
const ceiling = (cells * budget).toFixed(2);
process.stderr.write(
  `${cells} cells (${chosen.length} tasks × ${chosenArms.length} arms × ${runs} runs)\n` +
    `worst case $${ceiling} at $${budget.toFixed(2)} per cell, model ${values.model}, effort ${values.effort}\n`,
);
if (!values.yes) fail('Refusing to spend without --yes.');

const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
let spent = 0;
for (const task of chosen) {
  for (const arm of chosenArms) {
    for (let index = 1; index <= runs; index++) {
      const cell = await runCell({ task, arm, index, model: values.model, effort: values.effort, budget, stamp });
      spent += cell.cost_usd ?? 0;
      process.stderr.write(
        `${task.id} ${arm.padEnd(8)} #${index}  ${String(cell.subtype).padEnd(18)} ` +
          `$${(cell.cost_usd ?? 0).toFixed(3)}  ${cell.turns ?? '?'} turns  running $${spent.toFixed(2)}\n`,
      );
    }
  }
}
process.stderr.write(`\nrecorded under bench/runs/${stamp} — score it with: npm run bench:replay\n`);
