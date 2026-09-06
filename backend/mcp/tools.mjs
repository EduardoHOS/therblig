import {
  branch,
  bypass,
  guard,
  insertAfter,
  lintClean,
  message,
  moveToLane,
  onError,
  parallel,
  parses,
  project,
  propose,
  references,
  rename,
  risk,
  timeout,
  xsdValid,
} from '../core/index.mjs';
import { writeBpmnAtomic } from '../io/bpmn-file.mjs';
import { explain } from '../cli/explain.mjs';

// A refusal the model can act on: it names the rule and the remedy, and reaches the client as a
// tool error rather than a protocol error, which is what the spec says models can self-correct from.
function refuse(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

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

const HANDLE = { type: 'string', description: 'From open. Opaque; carry it forward unchanged.' };
const object = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

// Every mutating tool takes the same three: which document, which revision it was reasoned
// against, and an id that makes a retry idempotent.
const MUTATING = {
  handle: HANDLE,
  base_rev: { type: 'string', description: 'The rev this edit was reasoned against.' },
  patch_id: { type: 'string', description: 'Caller-chosen; the same id twice applies once.' },
  args: { type: 'object', description: 'The op arguments.' },
};

export function toolsFor({ store, root, autonomous }) {
  const tools = [];
  const add = (name, description, inputSchema, handler) =>
    tools.push({ name, description, inputSchema, handler });

  add(
    'open',
    'Open a .bpmn file inside the workspace. Returns an opaque handle and the current revision; both are needed by every other tool. Handles live as long as this server process.',
    object({ path: { type: 'string' } }, ['path']),
    async ({ path }) => store.open(path),
  );

  add(
    'project',
    'The coordinate-free IR of the published revision: ids, types, names, containers, lanes and flows. No coordinates, and no XML.',
    object({ handle: HANDLE, scope: { type: 'string' } }, ['handle']),
    async ({ handle, scope }) => project(store.head(handle).document.definitions, { scope }),
  );

  add(
    'explain',
    'A deterministic reading of the process: what each container holds, which handlers are attached, what can never run and what never ends.',
    object({ handle: HANDLE }, ['handle']),
    async ({ handle }) => {
      const { document } = store.head(handle);
      return { text: explain('document', project(document.definitions)) };
    },
  );

  add(
    'lint',
    'Run every single-document gate against the published revision: parse, XSD, reference integrity and bpmnlint correctness.',
    object({ handle: HANDLE }, ['handle']),
    async ({ handle }) => {
      const { xml } = store.head(handle);
      return {
        parses: await parses(xml),
        xsdValid: await xsdValid(xml),
        references: await references(xml),
        lintClean: await lintClean(xml, { config: { extends: 'bpmnlint:correctness' } }),
      };
    },
  );

  const dryRun = async ({ handle, base_rev: baseRev, patch_id: patchId }, envelope) => {
    const remembered = store.remembered(handle, patchId);
    if (remembered) return remembered;

    store.requireHead(handle, baseRev);
    const { document } = store.head(handle);
    const result = await propose(document, envelope.plan);
    const rev = await store.candidate(handle, result.xml, { risk: envelope.risk, ok: result.ok });

    return store.remember(handle, patchId, {
      rev,
      op: envelope.op,
      risk: envelope.risk,
      explain: envelope.explain,
      plan: envelope.plan,
      inverse: envelope.inverse,
      minted: envelope.minted,
      ok: result.ok,
      gates: result.gates,
      diff: result.diff,
    });
  };

  for (const [name, op] of Object.entries(OPS)) {
    add(
      name,
      `Propose a ${name} edit. Nothing is written: the result carries the plan, its exact inverse, the computed risk, every gate and the measured diff. Publish the returned rev to make it real.`,
      object(MUTATING, ['handle', 'base_rev', 'patch_id', 'args']),
      async (input) => {
        const { document } = store.head(input.handle);
        return dryRun(input, op(project(document.definitions), input.args));
      },
    );
  }

  add(
    'patch',
    'Propose a plan of raw primitives (add, set, del, connect) for what the named ops do not cover. Judged by exactly the same gates and the same computed risk.',
    object(
      {
        handle: MUTATING.handle,
        base_rev: MUTATING.base_rev,
        patch_id: MUTATING.patch_id,
        plan: { type: 'array', items: { type: 'object' } },
      },
      ['handle', 'base_rev', 'patch_id', 'plan'],
    ),
    async (input) =>
      dryRun(input, {
        op: 'patch',
        plan: input.plan,
        inverse: [],
        minted: [],
        risk: risk(input.plan),
        explain: `${input.plan.length} operations, as given.`,
      }),
  );

  add(
    'publish',
    `Write a proposed revision to disk, atomically. Refused if any gate failed, or if the edit's risk is above this server's allowance (${[...autonomous].join(', ')}).`,
    object(
      { handle: HANDLE, rev: { type: 'string' }, patch_id: { type: 'string' } },
      ['handle', 'rev', 'patch_id'],
    ),
    async ({ handle, rev, patch_id: patchId }) => {
      const remembered = store.remembered(handle, patchId);
      if (remembered) return remembered;

      const { xml, path, proposal } = store.revision(handle, rev);
      if (!proposal.ok) throw refuse('gate-failed', `Revision "${rev}" did not pass every gate`);
      if (!autonomous.has(proposal.risk)) {
        throw refuse(
          'requires-approval',
          `publishing a ${proposal.risk} edit needs a human — this server allows ${[...autonomous].join(', ')}`,
        );
      }

      await writeBpmnAtomic(path, xml, { root });
      store.promote(handle, rev);
      return store.remember(handle, patchId, { rev, published: true, risk: proposal.risk });
    },
  );

  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
