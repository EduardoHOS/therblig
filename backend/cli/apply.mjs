import { readFile } from 'node:fs/promises';

import {
  branch,
  bypass,
  guard,
  insertAfter,
  message,
  moveToLane,
  onError,
  parallel,
  rename,
  risk,
  timeout,
} from '../core/index.mjs';
import { confine } from '../io/bpmn-file.mjs';

// The ops a caller may name, and the whole of it: raw primitives come in through --plan, where
// the computed risk judges them exactly the same way. The keys are the allowlist.
const OPS = {
  branch,
  bypass,
  guard,
  insertAfter,
  message,
  moveToLane,
  onError,
  parallel,
  rename,
  timeout,
};

const LEVELS = ['safe', 'additive', 'routing', 'destructive'];

function usage(message) {
  const error = new Error(message);
  error.code = 'usage';
  return error;
}

export function allowanceOf(value) {
  const allowed = (value ?? 'safe,additive').split(',').map((level) => level.trim());
  const unknown = allowed.filter((level) => !LEVELS.includes(level));
  if (unknown.length) {
    throw usage(`Unknown risk level "${unknown[0]}" — pick from ${LEVELS.join(', ')}`);
  }
  return new Set(allowed);
}

async function planFrom(path, root) {
  const text = await confine(root, path)
    .then((confined) => readFile(confined, 'utf8'))
    .catch(() => {
      throw usage(`Cannot read plan "${path}"`);
    });

  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw usage(`Plan "${path}" is not JSON`);
  }
  if (!Array.isArray(plan)) throw usage(`Plan "${path}" must be an array of operations`);

  // The same envelope shape an op returns, so everything downstream treats them identically.
  return {
    op: 'plan',
    plan,
    minted: [],
    risk: risk(plan),
    explain: `${plan.length} ${plan.length === 1 ? 'operation' : 'operations'}, as given.`,
  };
}

export async function envelopeFor(values, { ir, root }) {
  if (values.plan) return planFrom(values.plan, root);

  if (!values.op) throw usage('Pass --op <name> --args <json>, or --plan <file>');
  const op = Object.hasOwn(OPS, values.op) ? OPS[values.op] : null;
  if (!op) throw usage(`Unknown op "${values.op}" — pick from ${Object.keys(OPS).join(', ')}`);
  if (values.args === undefined) throw usage(`Op "${values.op}" needs --args <json>`);

  let args;
  try {
    args = JSON.parse(values.args);
  } catch {
    throw usage('--args is not JSON');
  }
  return op(ir, args);
}
