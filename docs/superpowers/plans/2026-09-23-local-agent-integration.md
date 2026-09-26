# Local agent integration and process creation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code in another project on this machine creates a `.bpmn` file and grows it into a valid process through `therblig-mcp`, loaded from this checkout as a local plugin, with every write gated.

**Architecture:** A pure `seed()` in the core builds the two-node process through `applyPatch` and `placeNew`; `createBpmn()` in io writes it with `wx`; the therblig MCP server gains `bpmn_create` and one `bpmn_<op>` tool per named operation, sharing one stateless handler that proposes, gates, checks the risk allowance and writes atomically. The plugin's `.mcp.json` points at the checkout in place.

**Tech Stack:** Node 22 ESM, `bpmn-moddle`, `@modelcontextprotocol/server@2.0.0` with `zod` and `fromJsonSchema`, `node:test`.

Spec: `docs/superpowers/specs/2026-09-23-local-agent-integration-design.md`.

## Global Constraints

- No new dependency. No `src/` directory. ESM with `node:` prefixes.
- `backend/core` never imports `node:fs`, `../io/` or `@modelcontextprotocol`; `adjacency.mjs` is the only assigner of `sourceRef`/`targetRef`/`incoming`/`outgoing`; a BPMN node type string (`bpmn:StartEvent`, …) may appear only in `backend/core/blocks/`. `backend/test/unit/architecture.test.mjs` enforces all of it.
- Core and io coverage: 100% lines, branches, functions (`npm run test:coverage`). Do not add an unreachable branch.
- Public errors start with a capital letter and name the remedy. MCP failures are tool errors (`isError: true`) with a `THB_*` code from `backend/io/errors.mjs`.
- `tools/list` on `therblig-mcp` is a fixed ordered set: `bpmn_read, bpmn_explain, bpmn_lint, bpmn_verify, bpmn_patch, bpmn_create, bpmn_branch, bpmn_bypass, bpmn_guard, bpmn_insert_after, bpmn_message, bpmn_move_to_lane, bpmn_on_error, bpmn_parallel, bpmn_rename, bpmn_timeout` (16).
- Default allowance `safe,additive`; the plugin sets `safe,additive,routing`. `--allow` replaces the list, it does not extend it.
- `npm` is not on PATH in this shell: run everything through `make` (`make check`, `make test`, `make types`) or `node` directly. `node --test <file>` runs one file.
- No commit, push or PR unless the user asks. "Checkpoint" steps below mean: run `git diff --check` and `git status --short`, nothing more.

---

### Task 1: `mintId` never mints an id that starts with a digit

An NCName cannot start with a digit. `mintId` slugs `"1st check"` to `1st_check`, which the XSD gate then rejects. The seed exposes this through `bpmn_create`'s `start`/`end` names, and every op already exposes it through step names. Root cause fix, one line.

**Files:**
- Modify: `backend/core/patch.mjs:52-59`
- Test: `backend/test/unit/patch.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/test/unit/patch.test.mjs`:

```js
test('mintId never starts an id with a digit, because an NCName cannot', async () => {
  const { mintId } = await import('../../core/patch.mjs');
  assert.equal(mintId(new Set(), '1st check'), '_1st_check');
  assert.equal(mintId(new Set(['_1st_check']), '1st check'), '_1st_check_2');
  assert.equal(mintId(new Set(), 'Fetch score'), 'Fetch_score');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test backend/test/unit/patch.test.mjs`
Expected: 1 failing, `'1st_check' !== '_1st_check'`.

- [ ] **Step 3: Fix `mintId`**

In `backend/core/patch.mjs`, replace the `slug` expression:

```js
export function mintId(byId, base) {
  // An XML id is an NCName: letters, digits, `_`, `-`, `.`, never starting with a digit.
  const slug =
    String(base).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^(?=\d)/, '_').slice(0, 24) ||
    'Element';
  let id = slug;
  let suffix = 1;
  while (byId.has(id)) id = `${slug}_${++suffix}`;
  return id;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `node --test backend/test/unit/`
Expected: all pass.

---

### Task 2: `seed()` in the core

**Files:**
- Create: `backend/core/seed.mjs`
- Modify: `backend/core/index.mjs` (export)
- Test: `backend/test/unit/seed.test.mjs`

**Interfaces:**
- Produces: `seed({ name, start = 'Start', end = 'End', executable = false }) → { document: {moddle, definitions}, ids: {definitions, process, start, end, flow} }`. Throws `Error` with `code: 'invalid-name'` when `name` is missing or blank.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/unit/seed.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  diCoverage,
  lintClean,
  parse,
  parses,
  project,
  references,
  seed,
  semantics,
  serialize,
  xsdValid,
} from '../../core/index.mjs';

const CORRECTNESS = { config: { extends: 'bpmnlint:correctness' } };

async function reread(document) {
  const xml = await serialize(document);
  const { definitions } = await parse(xml);
  return { xml, definitions, ir: project(definitions) };
}

test('a seed is a start and an end, connected, with DI for all three', async () => {
  const { document, ids } = seed({ name: 'Pedido', start: 'Pedido recebido', end: 'Pedido concluído' });
  const { definitions, ir } = await reread(document);

  assert.deepEqual(
    ir.nodes.map((node) => [node.id, node.type, node.name]),
    [[ids.start, 'start', 'Pedido recebido'], [ids.end, 'end', 'Pedido concluído']],
  );
  assert.deepEqual(ir.flows.map((flow) => [flow.id, flow.from, flow.to]), [[ids.flow, ids.start, ids.end]]);
  assert.equal(ir.processes[0].id, ids.process);
  assert.equal(ir.processes[0].name, 'Pedido');
  assert.equal(ir.processes[0].executable, false);
  assert.equal(definitions.id, ids.definitions);

  const coverage = diCoverage(definitions);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.covered, 3);
  assert.deepEqual(coverage.missing, []);
});

test('a seed passes every gate', async () => {
  const { xml } = await reread(seed({ name: 'Onboarding' }).document);
  assert.equal((await parses(xml)).ok, true);
  assert.equal((await xsdValid(xml)).ok, true);
  assert.equal((await references(xml)).ok, true);
  assert.equal((await semantics(xml)).ok, true);
  assert.equal((await lintClean(xml, CORRECTNESS)).ok, true);
});

test('a seed is deterministic and its defaults are Start and End', async () => {
  const first = await reread(seed({ name: 'Same' }).document);
  const second = await reread(seed({ name: 'Same' }).document);
  assert.equal(first.xml, second.xml);
  assert.deepEqual(first.ir.nodes.map((node) => node.name), ['Start', 'End']);
});

test('spaces, accents and a leading digit still yield XSD-valid ids', async () => {
  const { document, ids } = seed({ name: 'Aprovação de crédito', start: '1º contato', end: 'Fim' });
  for (const id of Object.values(ids)) assert.match(id, /^[A-Za-z_][A-Za-z0-9_]*$/, id);
  assert.equal((await xsdValid((await reread(document)).xml)).ok, true);
});

test('executable lands on the process', async () => {
  const { ir } = await reread(seed({ name: 'Run', executable: true }).document);
  assert.equal(ir.processes[0].executable, true);
});

test('a blank or missing name is refused with a code', () => {
  for (const args of [{ name: '   ' }, { name: 7 }, {}, undefined]) {
    assert.throws(() => seed(args), (error) => {
      assert.equal(error.code, 'invalid-name');
      assert.match(error.message, /needs a name/);
      return true;
    });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test backend/test/unit/seed.test.mjs`
Expected: fails at import, `seed` is not exported.

- [ ] **Step 3: Write `backend/core/seed.mjs`**

```js
/**
 * @typedef {object} Seed
 * @property {{moddle: unknown, definitions: unknown}} document
 * @property {{definitions: string, process: string, start: string, end: string, flow: string}} ids
 */

import BpmnModdle from 'bpmn-moddle';

import { applyPatch, mintId } from './patch.mjs';
import { placeNew } from './placement.mjs';

// The namespace Camunda Modeler writes; the XSD gate accepts it and nothing downstream reads it.
const NAMESPACE = 'http://bpmn.io/schema/bpmn';

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The smallest process worth growing: a start and an end, connected, with DI for all three.
 *
 * Nothing but these three elements is ever generated from nothing. The nodes and the flow go in
 * through `applyPatch`, so they are built, linked and minted exactly as an op's plan would be; the
 * plane is created empty and `placeNew` draws into it, which is incremental placement and not a
 * layouter. Every later change goes through the ops with their gates, inverse and risk.
 *
 * @param {{name: string, start?: string, end?: string, executable?: boolean}} [args]
 * @returns {Seed}
 */
export function seed({ name, start = 'Start', end = 'End', executable = false } = {}) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title) throw refuse('invalid-name', 'A process needs a name — pass a non-empty name');

  const taken = new Set();
  const mint = (hint) => {
    const id = mintId(taken, hint);
    taken.add(id);
    return id;
  };
  const ids = {
    definitions: mint(`Definitions_${title}`),
    process: mint(`Process_${title}`),
    start: mint(start),
    end: mint(end),
  };
  ids.flow = mint(`Flow_${ids.start}`);

  const moddle = new BpmnModdle();
  const process = moddle.create('bpmn:Process', {
    id: ids.process,
    name: title,
    isExecutable: executable,
    flowElements: [],
  });
  const definitions = moddle.create('bpmn:Definitions', {
    id: ids.definitions,
    targetNamespace: NAMESPACE,
    rootElements: [process],
  });
  process.$parent = definitions;

  const plane = moddle.create('bpmndi:BPMNPlane', {
    id: mint(`Plane_${title}`),
    bpmnElement: process,
    planeElement: [],
  });
  const diagram = moddle.create('bpmndi:BPMNDiagram', { id: mint(`Diagram_${title}`), plane });
  plane.$parent = diagram;
  diagram.$parent = definitions;
  definitions.diagrams = [diagram];

  const document = { moddle, definitions };
  applyPatch(document, [
    { op: 'add', type: 'start', in: ids.process, id: ids.start, name: start },
    { op: 'add', type: 'end', in: ids.process, id: ids.end, name: end },
    { op: 'connect', from: ids.start, to: ids.end, id: ids.flow },
  ]);
  placeNew(document, [ids.start, ids.end, ids.flow]);

  return { document, ids };
}
```

Add to `backend/core/index.mjs`, after the `propose` export line:

```js
export { seed } from './seed.mjs';
```

and add `@typedef {import('./seed.mjs').Seed} Seed` to the typedef block at the top.

- [ ] **Step 4: Run the seed tests, then the architecture test**

Run: `node --test backend/test/unit/seed.test.mjs backend/test/unit/architecture.test.mjs`
Expected: all pass. If the architecture test names `seed.mjs`, a block type string leaked in: only `bpmn:Process`, `bpmn:Definitions`, `bpmndi:BPMNPlane`, `bpmndi:BPMNDiagram` may appear.

- [ ] **Step 5: Checkpoint**

`git diff --check && git status --short`

---

### Task 3: `allowanceOf` moves to the core

**Files:**
- Modify: `backend/core/ops.mjs` (after `risk`), `backend/core/index.mjs`, `backend/cli/apply.mjs` (remove `LEVELS`, `allowanceOf`), `backend/cli/main.mjs:20`
- Test: `backend/test/unit/ops.test.mjs` (append)

**Interfaces:**
- Produces: `allowanceOf(value?: string) → Set<RiskLevel>`; throws `Error` with `code: 'unknown-risk-level'` naming the level and the list.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/unit/ops.test.mjs` (add `allowanceOf` to the import from `../../core/index.mjs`):

```js
test('allowanceOf defaults to safe and additive, trims, and refuses an unknown level', () => {
  assert.deepEqual([...allowanceOf()], ['safe', 'additive']);
  assert.deepEqual([...allowanceOf(' safe, routing ')], ['safe', 'routing']);
  assert.throws(() => allowanceOf('safe,catastrophic'), (error) => {
    assert.equal(error.code, 'unknown-risk-level');
    assert.match(error.message, /"catastrophic".*safe, additive, routing, destructive/);
    return true;
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test backend/test/unit/ops.test.mjs`
Expected: fails, `allowanceOf` is not exported.

- [ ] **Step 3: Move the function**

In `backend/core/ops.mjs`, directly after `export function risk(plan) {…}`:

```js
/**
 * The risk levels a caller lets a write reach. Comma-separated, `safe,additive` when absent, and
 * closed: a level outside LEVEL fails here rather than silently allowing nothing or everything.
 * @param {string} [value] @returns {Set<RiskLevel>}
 */
export function allowanceOf(value) {
  const allowed = (value ?? 'safe,additive').split(',').map((level) => level.trim());
  const unknown = allowed.find((level) => !LEVEL.includes(level));
  if (unknown !== undefined) {
    throw precondition(
      'unknown-risk-level',
      `Unknown risk level "${unknown}" — pick from ${LEVEL.join(', ')}`,
    );
  }
  return new Set(allowed);
}
```

In `backend/core/index.mjs`, add `allowanceOf,` to the `./ops.mjs` export list (alphabetical: first).

In `backend/cli/apply.mjs`: delete `const LEVELS = […]` and the whole `export function allowanceOf` block.

In `backend/cli/main.mjs`: change line 20 to `import { envelopeFor } from './apply.mjs';` and add `allowanceOf,` to the `../core/index.mjs` import list (alphabetical: first).

- [ ] **Step 4: Run the unit tests and the CLI smoke**

Run: `node --test backend/test/unit/ops.test.mjs backend/test/smoke/cli-write.test.mjs`
Expected: all pass. If a smoke test matched the old plain message for an unknown `--allow`, the CLI now prints `unknown-risk-level: Unknown risk level …` (its `fail` prefixes non-usage codes); update that assertion to `/Unknown risk level/`.

---

### Task 4: `createBpmn` in io

**Files:**
- Modify: `backend/io/bpmn-file.mjs` (imports + new export)
- Test: `backend/test/unit/io.test.mjs` (append)

**Interfaces:**
- Produces: `createBpmn(path, xml, { root }) → Promise<{ path: string, rev: string }>`. Errors carry `code`: `'not-bpmn'`, `'exists'`, `'path-outside-root'`, or the fs code (`ENOENT` for a missing parent).

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/unit/io.test.mjs` (add `createBpmn` to the import from `../../io/bpmn-file.mjs`, and `chmod`, `stat` to the `node:fs/promises` import):

```js
test('createBpmn writes a new file, returns its revision, and never leaves a temporary', async () => {
  const { root, xml } = await workspace();
  const { path, rev } = await createBpmn('new.bpmn', xml, { root });

  assert.equal(await readFile(path, 'utf8'), xml);
  assert.match(rev, /^[0-9a-f]{12}$/);
  assert.deepEqual(await leftovers(root), []);
});

test('createBpmn refuses to overwrite and leaves the existing bytes alone', async () => {
  const { root, target, xml } = await workspace();
  await assert.rejects(createBpmn(target, '<other/>', { root }), (error) => {
    assert.equal(error.code, 'exists');
    assert.match(error.message, /already exists/);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), xml);
});

test('createBpmn refuses a path outside the root, a non-.bpmn name, and a missing parent', async () => {
  const { root, xml } = await workspace();
  await assert.rejects(createBpmn(join(root, '..', 'escape.bpmn'), xml, { root }), /outside the workspace/);
  await assert.rejects(createBpmn('seed.xml', xml, { root }), (error) => {
    assert.equal(error.code, 'not-bpmn');
    return true;
  });
  await assert.rejects(createBpmn(join('nowhere', 'seed.bpmn'), xml, { root }), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('createBpmn removes what it wrote when the bytes do not parse back', async () => {
  const { root } = await workspace();
  const target = join(root, 'broken.bpmn');
  await assert.rejects(createBpmn(target, '<nope/>', { root }), /does not parse/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('createBpmn surfaces a failure to open that is not EEXIST', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { root, xml } = await workspace();
  const locked = join(root, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o500);
  try {
    await assert.rejects(createBpmn(join('locked', 'seed.bpmn'), xml, { root }), { code: 'EACCES' });
  } finally {
    await chmod(locked, 0o700);
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test backend/test/unit/io.test.mjs`
Expected: fails, `createBpmn` is not exported.

- [ ] **Step 3: Implement**

In `backend/io/bpmn-file.mjs`: extend the imports

```js
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

import { parse } from '../core/index.mjs';
import { revOf } from './rev.mjs';
```

and append:

```js
function coded(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// Create a file that must not exist yet. `wx` is the primitive that cannot overwrite, so there
// is no temporary and no rename: nothing existed before, so the only thing to protect is the disk
// after a failure — and the target is unlinked on every path that throws past the open.
export async function createBpmn(path, xml, { root }) {
  if (extname(path).toLowerCase() !== '.bpmn') {
    throw coded('not-bpmn', `"${basename(path)}" is not a .bpmn file — a new process is written as .bpmn`);
  }
  const confined = await confine(root, path);

  let handle;
  try {
    handle = await open(confined, 'wx');
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    throw coded('exists', `"${basename(confined)}" already exists — edit it instead, or pick another path`, cause);
  }

  try {
    try {
      await handle.writeFile(xml, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const bytes = await readFile(confined);
    await parse(bytes.toString('utf8')).catch((cause) => {
      throw coded('parse-failed', `Refusing to keep "${basename(confined)}": the result does not parse`, cause);
    });
    return { path: confined, rev: revOf(bytes) };
  } catch (error) {
    await unlink(confined).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 4: Run the io tests with coverage**

Run: `node --test --experimental-test-coverage --test-coverage-include='backend/io/**/*.mjs' backend/test/unit/io.test.mjs backend/test/unit/io-integration.test.mjs backend/test/e2e/write.test.mjs`
Expected: all pass; `bpmn-file.mjs` at 100% lines, branches, functions. The `unlink(...).catch(() => {})` callback runs on the parse-back test (the file exists, so unlink succeeds and the callback is not invoked) — if the function-coverage report flags that arrow, replace it with `await unlink(confined).catch(swallow)` where `const swallow = () => {}` is shared with `writeBpmnAtomic`'s identical call.

- [ ] **Step 5: Checkpoint**

---

### Task 5: `therblig-mcp` creates, proposes, gates, allows, writes

**Files:**
- Modify: `backend/io/errors.mjs` (codes + `extra`), `backend/mcp/tools.mjs` (export `OPS`, `ARGS`), `backend/mcp/server.mjs`, `backend/mcp/bin.mjs`, `backend/core/ops.mjs` (`riskOf` accepts `move`/`message`)
- Create: `backend/test/support/mcp-client.mjs`, `backend/test/smoke/therblig-mcp.test.mjs`
- Modify: `backend/test/smoke/mcp.test.mjs` (use the shared client), `backend/test/e2e/mcp.test.mjs:52-53` (16 tools)

**Interfaces:**
- Consumes: `seed`, `allowanceOf`, `risk`, `propose`, `project`, `parse`, `serialize` from the core; `createBpmn` from io; `atomicWrite`, `readWithRev`, `revOf` from io; `OPS`, `ARGS` from `tools.mjs`.
- Produces: `createServer(root, { allowance } = {})`; tool names as in Global Constraints; result bodies as in the spec.

- [ ] **Step 1: The shared stdio client**

Create `backend/test/support/mcp-client.mjs` by moving `META` and `client` out of `backend/test/smoke/mcp.test.mjs` unchanged, with one wider signature:

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TREADLE_SERVER = fileURLToPath(new URL('../../mcp/server.mjs', import.meta.url));
export const THERBLIG_BIN = fileURLToPath(new URL('../../mcp/bin.mjs', import.meta.url));

// Every request in revision 2026-07-28 carries these; there is no initialize handshake.
export const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'therblig-smoke', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/**
 * A JSON-RPC client over stdio, so a test drives the real entrypoint the way a client does.
 * @param {string} cwd
 * @param {{server?: string, args?: string[], env?: Record<string, string>}} [options]
 */
export function client(cwd, { server = TREADLE_SERVER, args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [server, ...args], { cwd, env: { ...process.env, ...env } });
  // … the existing body verbatim: pending map, stdout/stderr accumulation, send, list, call, stdout, stderr, close
}
```

In `backend/test/smoke/mcp.test.mjs`: delete the local `META`, `client` and `SERVER` constant; add `import { client, TREADLE_SERVER as SERVER } from '../support/mcp-client.mjs';` and keep every existing call site compiling (`client(cwd)` stays valid; a call that passed a second positional server becomes `client(cwd, { server })`).

Run: `node --test backend/test/smoke/mcp.test.mjs` — Expected: all pass, unchanged count.

- [ ] **Step 2: Write the failing therblig smoke tests**

Create `backend/test/smoke/therblig-mcp.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { client, THERBLIG_BIN } from '../support/mcp-client.mjs';

const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));

const TOOLS = [
  'bpmn_read', 'bpmn_explain', 'bpmn_lint', 'bpmn_verify', 'bpmn_patch', 'bpmn_create',
  'bpmn_branch', 'bpmn_bypass', 'bpmn_guard', 'bpmn_insert_after', 'bpmn_message',
  'bpmn_move_to_lane', 'bpmn_on_error', 'bpmn_parallel', 'bpmn_rename', 'bpmn_timeout',
];
const WIDE = ['--allow', 'safe,additive,routing'];

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'therblig-mcp-'));
  await cp(join(CORPUS, 'handmade/zeebe-roundtrip.bpmn'), join(cwd, 'p.bpmn'));
  await mkdir(join(cwd, 'processos'));
  return cwd;
}

const serve = (cwd, args = [], env = {}) =>
  client(cwd, { server: THERBLIG_BIN, args: ['--root', cwd, ...args], env });

const refused = (result, code) => {
  assert.equal(result.isError, true, result.text);
  const body = JSON.parse(result.text);
  assert.equal(body.code, code, result.text);
  return body;
};

test('tools/list is the sixteen tools, in a fixed order, with exact op schemas', async () => {
  const mcp = serve(await workspace());
  try {
    const first = await mcp.list();
    assert.deepEqual(first.result.tools.map((tool) => tool.name), TOOLS);
    for (const tool of first.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.ok(tool.description.length > 0, tool.name);
    }
    const branch = first.result.tools.find((tool) => tool.name === 'bpmn_branch');
    assert.deepEqual(branch.inputSchema.required, ['path', 'args']);
    assert.deepEqual(branch.inputSchema.properties.args.required, ['anchor', 'when', 'yes']);
    assert.ok(branch.inputSchema.properties.args.properties.label, 'label is declared');
    const second = await mcp.list();
    assert.deepEqual(second.result.tools, first.result.tools);
  } finally {
    mcp.close();
  }
});

test('an agent creates a process and grows it: create → insert → branch → timeout → on_error → lint clean', async () => {
  const cwd = await workspace();
  const mcp = serve(cwd, WIDE);
  try {
    const made = await mcp.call('bpmn_create', {
      path: 'processos/pedido.bpmn', name: 'Pedido', start: 'Pedido recebido', end: 'Pedido concluído',
    });
    assert.equal(made.isError, false, made.text);
    assert.match(made.data.base_rev, /^[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(made.data.ids).sort(), ['definitions', 'end', 'flow', 'process', 'start']);
    const path = 'processos/pedido.bpmn';
    let rev = made.data.base_rev;

    const write = async (tool, args) => {
      const result = await mcp.call(tool, { path, args, dry_run: false, base_rev: rev });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.data.written, true);
      assert.notEqual(result.data.new_rev, rev);
      rev = result.data.new_rev;
      return result.data;
    };

    const inserted = await write('bpmn_insert_after', {
      anchor: made.data.ids.start, step: { type: 'user', name: 'Conferir pedido' },
    });
    assert.equal(inserted.risk, 'additive');
    const [conferir] = inserted.minted;

    const branched = await write('bpmn_branch', {
      anchor: conferir, when: 'aprovado', name: 'Aprovado?', label: 'sim',
      yes: [{ type: 'service', name: 'Separar' }], no: [{ type: 'user', name: 'Corrigir' }],
    });
    assert.equal(branched.risk, 'routing');

    await write('bpmn_timeout', { on: conferir, after: 'P2D', to: made.data.ids.end, name: 'Atrasou' });
    await write('bpmn_on_error', { on: conferir, to: made.data.ids.end, name: 'Falhou' });

    const lint = await mcp.call('bpmn_lint', { path });
    assert.equal(lint.data.errors, 0, lint.text);
    assert.equal(lint.data.base_rev, rev);

    const outline = await mcp.call('bpmn_read', { path, view: 'outline' });
    const types = outline.data.nodes.map((node) => node.type).sort();
    assert.deepEqual(types, ['boundary', 'boundary', 'end', 'service', 'start', 'user', 'user', 'xor', 'xor']);
    assert.ok((await readFile(join(cwd, path), 'utf8')).includes('bpmndi:BPMNShape'));
  } finally {
    mcp.close();
  }
});

test('a branch without a label fails the lint gate: visible on a dry run, refused on a write', async () => {
  const cwd = await workspace();
  const mcp = serve(cwd, WIDE);
  try {
    const made = await mcp.call('bpmn_create', { path: 'processos/x.bpmn', name: 'X' });
    const args = { anchor: made.data.ids.start, when: 'ok', yes: [{ type: 'task', name: 'Yes' }] };
    const preview = await mcp.call('bpmn_branch', { path: 'processos/x.bpmn', args });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.data.ok, false);
    assert.equal(preview.data.dry_run, true);
    assert.equal(preview.data.gates.lintClean.ok, false);
    assert.ok(preview.data.gates.lintClean.introduced.some((rule) => rule.startsWith('label-required')));

    const write = await mcp.call('bpmn_branch', { path: 'processos/x.bpmn', args, dry_run: false, base_rev: made.data.base_rev });
    const body = refused(write, 'THB_GATE_FAILED');
    assert.equal(body.gates.lintClean.ok, false);
    const reread = await mcp.call('bpmn_read', { path: 'processos/x.bpmn', view: 'outline' });
    assert.equal(reread.data.base_rev, made.data.base_rev, 'nothing was written');
  } finally {
    mcp.close();
  }
});

test('a write needs the current base_rev', async () => {
  const mcp = serve(await workspace());
  try {
    const args = { id: 'Charge', name: 'Charge the card' };
    refused(await mcp.call('bpmn_rename', { path: 'p.bpmn', args, dry_run: false }), 'THB_REV_REQUIRED');
    refused(await mcp.call('bpmn_rename', { path: 'p.bpmn', args, dry_run: false, base_rev: 'deadbeefcafe' }), 'THB_STALE_REV');
    const read = await mcp.call('bpmn_read', { path: 'p.bpmn', view: 'outline' });
    const ok = await mcp.call('bpmn_rename', { path: 'p.bpmn', args, dry_run: false, base_rev: read.data.base_rev });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.written, true);
  } finally {
    mcp.close();
  }
});

test('routing is refused under the default allowance, written under a wider one, and TREADLE_ALLOW widens it too', async () => {
  const cwd = await workspace();
  const args = (start) => ({ anchor: start, when: 'ok', label: 'yes', yes: [{ type: 'task', name: 'Yes' }] });

  const strict = serve(cwd);
  try {
    const made = await strict.call('bpmn_create', { path: 'processos/a.bpmn', name: 'A' });
    const body = refused(
      await strict.call('bpmn_branch', { path: 'processos/a.bpmn', args: args(made.data.ids.start), dry_run: false, base_rev: made.data.base_rev }),
      'THB_REQUIRES_APPROVAL',
    );
    assert.equal(body.risk, 'routing');
    assert.deepEqual(body.allowance, ['safe', 'additive']);
    assert.match(body.error, /needs a human/);
  } finally {
    strict.close();
  }

  const viaEnv = serve(cwd, [], { TREADLE_ALLOW: 'safe,additive,routing' });
  try {
    const read = await viaEnv.call('bpmn_read', { path: 'processos/a.bpmn', view: 'outline' });
    const start = read.data.nodes.find((node) => node.type === 'start').id;
    const ok = await viaEnv.call('bpmn_branch', { path: 'processos/a.bpmn', args: args(start), dry_run: false, base_rev: read.data.base_rev });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.written, true);
  } finally {
    viaEnv.close();
  }
});

test('bpmn_patch obeys the same allowance: del needs destructive', async () => {
  const cwd = await workspace();
  const strict = serve(cwd);
  try {
    const read = await strict.call('bpmn_read', { path: 'p.bpmn', view: 'outline' });
    const ops = [{ op: 'del', id: 'Charge' }];
    refused(await strict.call('bpmn_patch', { path: 'p.bpmn', ops, dry_run: false, base_rev: read.data.base_rev }), 'THB_REQUIRES_APPROVAL');
    const preview = await strict.call('bpmn_patch', { path: 'p.bpmn', ops });
    assert.equal(preview.isError, false, 'a preview is never refused for risk');
  } finally {
    strict.close();
  }
  const wide = serve(cwd, ['--allow', 'safe,additive,routing,destructive']);
  try {
    const read = await wide.call('bpmn_read', { path: 'p.bpmn', view: 'outline' });
    const ok = await wide.call('bpmn_patch', { path: 'p.bpmn', ops: [{ op: 'del', id: 'Charge' }], dry_run: false, base_rev: read.data.base_rev });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.written, true);
  } finally {
    wide.close();
  }
});

test('bpmn_create refuses an existing file, a path outside the root, a .xml name and a missing parent', async () => {
  const cwd = await workspace();
  const mcp = serve(cwd);
  try {
    refused(await mcp.call('bpmn_create', { path: 'p.bpmn', name: 'P' }), 'THB_EXISTS');
    refused(await mcp.call('bpmn_create', { path: join(cwd, '..', 'escape.bpmn'), name: 'P' }), 'THB_OUTSIDE_ROOT');
    refused(await mcp.call('bpmn_create', { path: 'p2.xml', name: 'P' }), 'THB_NOT_BPMN');
    refused(await mcp.call('bpmn_create', { path: 'nowhere/p.bpmn', name: 'P' }), 'THB_NOT_FOUND');
    refused(await mcp.call('bpmn_create', { path: 'blank.bpmn', name: '   ' }), 'THB_OP_REFUSED');
    const verify = await mcp.call('bpmn_verify', { path: 'p.bpmn' });
    assert.equal(verify.data.ok, true);
  } finally {
    mcp.close();
  }
});

test('an op precondition is a tool error carrying the core rule, and unknown ids are named', async () => {
  const cwd = await workspace();
  const mcp = serve(cwd);
  try {
    const made = await mcp.call('bpmn_create', { path: 'processos/e.bpmn', name: 'E' });
    const dangling = refused(
      await mcp.call('bpmn_insert_after', { path: 'processos/e.bpmn', args: { anchor: made.data.ids.end, step: { type: 'task' } } }),
      'THB_OP_REFUSED',
    );
    assert.equal(dangling.reason, 'anchor-no-outgoing');
    assert.match(dangling.error, /no outgoing flow/);
    const missing = refused(
      await mcp.call('bpmn_timeout', { path: 'processos/e.bpmn', args: { on: 'Nope', after: 'P1D', to: made.data.ids.end } }),
      'THB_OP_REFUSED',
    );
    assert.equal(missing.reason, 'element-not-found');
  } finally {
    mcp.close();
  }
});

test('stdout is protocol only; the banner names the root and the allowance on stderr', async () => {
  const cwd = await workspace();
  const mcp = serve(cwd, WIDE);
  try {
    await mcp.list();
    await mcp.call('bpmn_create', { path: 'processos/s.bpmn', name: 'S' });
    for (const line of mcp.stdout()) assert.doesNotThrow(() => JSON.parse(line), line);
    assert.match(mcp.stderr(), /serving .*allowing safe,additive,routing/);
  } finally {
    mcp.close();
  }
});

test('an unknown --allow level refuses to start', async () => {
  const cwd = await workspace();
  const run = spawnSync(process.execPath, [THERBLIG_BIN, '--root', cwd, '--allow', 'safe,bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown risk level "bogus"/);
  assert.equal(run.stdout, '');
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `node --test backend/test/smoke/therblig-mcp.test.mjs`
Expected: the tools/list test fails on the name list (five tools); the rest fail with unknown tool errors.

- [ ] **Step 4: Error codes carry extra detail**

In `backend/io/errors.mjs`, add to `CODES`:

```js
  THB_EXISTS: 'A file is already at that path. Edit it with bpmn_patch or the op tools, or pick another path.',
  THB_REQUIRES_APPROVAL: 'This server is not allowed to write an edit of that risk on its own. Ask the user, and have them restart the server with --allow or TREADLE_ALLOW naming the level.',
  THB_GATE_FAILED: 'A gate failed on the proposed result, so nothing was written. Each gate in this result names what it checks; fix the plan and propose again.',
  THB_OP_REFUSED: 'The operation refused before producing a plan. The reason names the rule and the remedy.',
```

and give `TherbligError` an optional third argument that rides into `toResult()`:

```js
  constructor(code, detail, extra = {}) {
    …existing body…
    this.extra = extra;
  }

  /** The shape every MCP tool returns on failure; `extra` carries what the caller needs to recover. */
  toResult() {
    return { ok: false, code: this.code, error: this.message, ...this.extra };
  }
```

- [ ] **Step 5: `risk` accepts the file API's two legacy verbs**

In `backend/core/ops.mjs`, `riskOf`:

```js
function riskOf(operation) {
  if (operation.op === 'move') return 'routing';
  if (operation.op === 'message') return 'additive';
  if (!PRIMITIVES.has(operation.op)) throw new Error(`Unknown operation "${operation.op}"`);
  …unchanged…
}
```

Append to `backend/test/unit/ops.test.mjs`:

```js
test('risk judges the file API verbs too: move is routing, message is additive', () => {
  assert.equal(risk([{ op: 'move', id: 'A', lane: 'L' }]), 'routing');
  assert.equal(risk([{ op: 'message', from: 'A', to: 'B' }]), 'additive');
  assert.throws(() => risk([{ op: 'teleport' }]), /Unknown operation "teleport"/);
});
```

- [ ] **Step 6: Export the op table**

In `backend/mcp/tools.mjs`, change `const OPS = {` to `export const OPS = {` and `const ARGS = {` to `export const ARGS = {`.

- [ ] **Step 7: The server**

In `backend/mcp/server.mjs`, extend the imports:

```js
import { parse, serialize } from '../core/document.mjs';
import { project } from '../core/projection.mjs';
import { allowanceOf, risk } from '../core/ops.mjs';
import { propose } from '../core/propose.mjs';
import { seed } from '../core/seed.mjs';
import { applyToFile, atomicWrite } from '../io/write.mjs';
import { createBpmn } from '../io/bpmn-file.mjs';
import { readWithRev, revOf } from '../io/rev.mjs';
import { ARGS, OPS, toolsFor } from './tools.mjs';
```

Change the signature and add the helpers right after `const guard = …`:

```js
// io throws coded plain Errors for the file it creates; the agent needs the taxonomy.
const CREATE_CODES = {
  exists: 'THB_EXISTS',
  'not-bpmn': 'THB_NOT_BPMN',
  'path-outside-root': 'THB_OUTSIDE_ROOT',
  ENOENT: 'THB_NOT_FOUND',
  ENOTDIR: 'THB_NOT_FOUND',
};
const asTherblig = (error) =>
  error instanceof TherbligError
    ? error
    : new TherbligError(CREATE_CODES[error.code] ?? 'THB_PARSE_FAILED', error.message);

// bpmn_<op> tool names: the op's camelCase, in the snake_case the other five tools use.
const toolNameOf = (op) => `bpmn_${op.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;

const refuseAbove = (allowance, level) => {
  if (allowance.has(level)) return;
  throw new TherbligError(
    'THB_REQUIRES_APPROVAL',
    `Publishing a ${level} edit needs a human — this server allows ${[...allowance].join(', ')}`,
    { risk: level, allowance: [...allowance] },
  );
};

/**
 * @param {string} root absolute, already realpath'd
 * @param {{allowance?: Set<string>}} [options]
 */
export function createServer(root, { allowance = allowanceOf(process.env.TREADLE_ALLOW) } = {}) {
```

Inside `bpmn_patch`'s handler, before `applyToFile`:

```js
    // Risk is judged on the primitives as given. An operation `risk` does not know is left for
    // applyToFile, which refuses it with THB_UNKNOWN_TYPE and the same message it always had.
    if (dry_run === false) {
      let level = null;
      try { level = risk(ops); } catch { level = null; }
      if (level) refuseAbove(allowance, level);
    }
```

After the `bpmn_patch` registration and before `return server;`, add the creation tool and the op loop:

```js
  server.registerTool('bpmn_create', {
    description:
      'Create a new .bpmn file: one process with a named start and end, connected, with diagram ' +
      'interchange for all three. Refused if the file exists. Grow it with the bpmn_<op> tools, ' +
      'anchored on the ids this returns.',
    inputSchema: z.object({
      path: z.string().describe('Where to write, ending in .bpmn; relative to the server root or absolute inside it. The parent directory must exist.'),
      name: z.string().min(1).describe('The process name.'),
      start: z.string().default('Start').describe('Name of the start event.'),
      end: z.string().default('End').describe('Name of the end event.'),
      executable: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guard(async ({ path, name, start, end, executable }) => {
    let made;
    try {
      made = seed({ name, start, end, executable });
    } catch (error) {
      throw new TherbligError('THB_OP_REFUSED', error.message, { reason: error.code });
    }
    const xml = await serialize(made.document);
    let written;
    try {
      written = await createBpmn(path, xml, { root });
    } catch (error) {
      throw asTherblig(error);
    }
    return json({ ok: true, path: written.path, base_rev: written.rev, ids: made.ids });
  }));

  // One tool per named op. Each carries the exact argument schema tools.mjs declares (Studio
  // F15: a generic `args` had an agent guessing names), and all of them share one handler.
  const runOp = async (name, { path, args, dry_run, base_rev }) => {
    const dryRun = dry_run !== false;
    const abs = await confine(root, path);
    const { xml, rev } = await readWithRev(abs);
    if (!dryRun && !base_rev) throw new TherbligError('THB_REV_REQUIRED');
    if (base_rev && base_rev !== rev) {
      throw new TherbligError('THB_STALE_REV', `You read ${base_rev}; the file is now ${rev}.`);
    }

    const document = await parse(xml);
    let envelope;
    let result;
    try {
      envelope = OPS[name](project(document.definitions), args);
      result = await propose(document, envelope.plan);
    } catch (error) {
      throw new TherbligError('THB_OP_REFUSED', error.message, { reason: error.code ?? 'operation-failed' });
    }

    const body = {
      ok: result.ok, dry_run: dryRun, base_rev: rev, op: envelope.op, risk: envelope.risk,
      explain: envelope.explain, plan: envelope.plan, inverse: envelope.inverse, minted: envelope.minted,
      gates: result.gates, diff: result.diff,
    };
    if (dryRun) return json(body);
    if (!result.ok) {
      const failing = Object.entries(result.gates).filter(([, gate]) => !gate.ok).map(([gate]) => gate);
      throw new TherbligError('THB_GATE_FAILED', `Failed: ${failing.join(', ')}`, { gates: result.gates });
    }
    refuseAbove(allowance, envelope.risk);
    await atomicWrite(abs, result.xml);
    return json({ ...body, written: true, new_rev: revOf(Buffer.from(result.xml, 'utf8')) });
  };

  const opTools = Object.keys(OPS).map((name) => [toolNameOf(name), name]).sort(([a], [b]) => a.localeCompare(b));
  for (const [toolName, name] of opTools) {
    server.registerTool(toolName, {
      description:
        `Propose a ${name} edit on a file. A dry run (the default) returns the plan, its exact ` +
        'inverse, the computed risk, every gate and the measured diff, and writes nothing. With ' +
        'dry_run false and the base_rev you read, the edit is written if every gate passes and its ' +
        'risk is within this server\'s allowance.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to a .bpmn file, absolute or relative to the server root.' },
          args: ARGS[name],
          dry_run: { type: 'boolean', default: true, description: 'true previews and writes nothing. false writes, and then base_rev is required.' },
          base_rev: { type: 'string', description: 'The revision you were given when you read the file. Required to write.' },
        },
        required: ['path', 'args'],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, guard((input) => runOp(name, input)));
  }
```

- [ ] **Step 8: The binary**

In `backend/mcp/bin.mjs`:

```js
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { allowanceOf } from '../core/ops.mjs';
import { resolveRoot } from '../io/paths.mjs';
import { createServer } from './server.mjs';
…
if (argv.includes('--help')) {
  process.stderr.write(
    'therblig-mcp — BPMN 2.0 over MCP, stdio.\n\n' +
    '  --root <dir>     directory the server may read AND WRITE (default: cwd)\n' +
    '  --allow <list>   risk levels a write may reach: safe, additive, routing, destructive\n' +
    '                   (default: safe,additive; also read from TREADLE_ALLOW)\n\n' +
    'Register with Claude Code:\n' +
    '  claude mcp add therblig -- npx -y therblig-mcp --root /path/to/project\n');
  process.exit(0);
}

const root = await resolveRoot(valueOf('--root') ?? process.cwd());
let allowance;
try {
  allowance = allowanceOf(valueOf('--allow') ?? process.env.TREADLE_ALLOW);
} catch (error) {
  process.stderr.write(`therblig-mcp: ${error.message}\n`);
  process.exit(1);
}
process.stderr.write(`therblig-mcp: serving ${root}, allowing ${[...allowance].join(',')}\n`);

await serveStdio(() => createServer(root, { allowance }), {
```

- [ ] **Step 9: The e2e count**

In `backend/test/e2e/mcp.test.mjs`, replace the five-tools check:

```js
check('tools/list returns the sixteen tools', tools.length === 16, `got ${tools.map((t) => t.name).join(', ') || 'nothing'}`);
```

- [ ] **Step 10: Run the MCP suites**

Run: `node --test backend/test/smoke/therblig-mcp.test.mjs backend/test/smoke/mcp.test.mjs backend/test/e2e/mcp.test.mjs`
Expected: all pass. If the outline `types` list in the growth test differs from the pinned one, print it once, confirm it is 9 nodes with 2 xor and 2 boundary, and pin what the file actually holds.

- [ ] **Step 11: Checkpoint**

---

### Task 6: Contracts, plugin, skill, README

**Files:**
- Modify: `backend/contracts/consumer.ts`, `plugin/plugins/therblig/.mcp.json`, `plugin/README.md`, `plugin/plugins/therblig/skills/bpmn-editing/SKILL.md`, `README.md:96-125`

- [ ] **Step 1: Contracts**

In `backend/contracts/consumer.ts`, extend the imports and add before `export const surface`:

```ts
import type { Envelope, Operation, Projection, RiskLevel, Seed } from 'therblig';
import { allowanceOf, insertAfter, propose, risk, seed } from 'therblig';
…
const made: Seed = seed({ name: 'Pedido', start: 'Recebido' });
const startId: string = made.ids.start;
const allowance: Set<RiskLevel> = allowanceOf('safe,additive,routing');

// @ts-expect-error a seed needs a name.
const nameless = seed({ start: 'Recebido' });
```

and add `startId, allowance` to the `surface` object.

Run: `make types` — Expected: both `tsc` runs exit 0.

- [ ] **Step 2: Plugin `.mcp.json`**

```json
{
  "mcpServers": {
    "therblig": {
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/../../../backend/mcp/bin.mjs",
        "--root",
        "${CLAUDE_PROJECT_DIR}"
      ],
      "env": {
        "TREADLE_ALLOW": "${TREADLE_ALLOW:-safe,additive,routing}"
      }
    }
  }
}
```

- [ ] **Step 3: Plugin README**

Replace the install block and the "Publishing this" section of `plugin/README.md`:

````markdown
# therblig — Claude Code plugin

A marketplace of one. Installs the therblig MCP server and a skill that teaches an agent
what BPMN's structure makes unsafe about ordinary text editing — and how to create a
process from nothing without writing XML.

## From this checkout, unpublished

The plugin runs the server in place from the repository it lives in, so nothing is
installed from npm. In Claude Code, from the project whose `.bpmn` files the agent may
create and edit:

```
/plugin marketplace add /absolute/path/to/treadle/plugin
/plugin install therblig@therblig
```

or, for a single session without a marketplace:

```
claude --plugin-dir /absolute/path/to/treadle/plugin/plugins/therblig
```

The server is confined to `${CLAUDE_PROJECT_DIR}`: it reads and writes `.bpmn` files
under that directory and nothing else, and it makes no network calls. Edits to the
server or the skill take effect at the next session or `/reload-plugins`.

### What the server may write on its own

`TREADLE_ALLOW` names the risk levels a write may reach without a human: `safe`
(names, documentation), `additive` (new steps, handlers, files), `routing` (gateways,
conditions, lanes), `destructive` (removal). The plugin sets `safe,additive,routing`, so
the agent can build a process — a process needs gateways — and cannot remove anything.
Export `TREADLE_ALLOW=safe,additive` before starting Claude Code to narrow it. A refused
write comes back as `THB_REQUIRES_APPROVAL`; the skill tells the agent to stop and ask.

To be asked before every write regardless of risk, add the write tools to
`permissions.ask` in the project's `.claude/settings.json`:

```json
{ "permissions": { "ask": ["mcp__therblig__bpmn_create", "mcp__therblig__bpmn_patch", "mcp__therblig__bpmn_*"] } }
```

## What is in here

```
.claude-plugin/marketplace.json      the marketplace manifest
plugins/therblig/
  .claude-plugin/plugin.json         the plugin manifest
  .mcp.json                          launches backend/mcp/bin.mjs from the checkout, rooted at the project
  skills/bpmn-editing/SKILL.md       what a model cannot infer from the tool schemas
```

## Publishing this

At publication the `command`/`args` pair in `.mcp.json` becomes
`npx -y -p therblig therblig-mcp --root ${CLAUDE_PROJECT_DIR}` and the plugin moves to
`EduardoHOS/therblig-plugin`, because `/plugin marketplace add` takes a repository and
the main repo carries a 23-file BPMN corpus nobody installing a plugin wants to clone.
Nothing else changes.

The skill is the part worth reading. It is not a restatement of the tool descriptions —
it is the things that have actually caused bugs here: adjacency stored twice, layout
that fails silently on 41% of the OMG's own reference models, the one-time reformat, the
comment loss that comes with it, and a gateway exit that goes unlabelled.
````

- [ ] **Step 4: Skill**

In `SKILL.md`, update the frontmatter description to
`Use when reading, explaining, linting, creating or editing a .bpmn file. Covers what BPMN's structure makes unsafe about ordinary text editing, how to create a process without writing XML, and how to use the therblig tools.`
and insert after the `# Editing BPMN files` intro paragraph:

````markdown
## Creating a process

Never write BPMN XML yourself. `bpmn_create` writes the smallest valid process — a named
start and end, connected, with diagram interchange — and returns `base_rev` and the ids
it minted. Everything after that is an edit:

```
bpmn_create       { path: "processos/pedido.bpmn", name: "Pedido", start: "Pedido recebido", end: "Pedido concluído" }
bpmn_insert_after { path, args: { anchor: <ids.start>, step: { type: "user", name: "Conferir pedido" } }, dry_run: false, base_rev }
bpmn_branch       { path, args: { anchor: "Conferir_pedido", when: "aprovado", name: "Aprovado?", label: "sim",
                    yes: [{ type: "service", name: "Separar" }], no: [{ type: "user", name: "Corrigir" }] }, dry_run: false, base_rev }
bpmn_timeout      { path, args: { on: "Conferir_pedido", after: "P2D", to: <ids.end>, name: "Atrasou" }, dry_run: false, base_rev }
```

Every write returns `new_rev`; pass it as the next call's `base_rev`. The `minted` list
in each result holds the ids you can anchor the next step on. The parent directory must
exist; create it with your own tools first.

Step types: `task`, `user`, `service`, `send`, `receive`, `manual`, `script`, `rule`,
`subprocess`, `call`; gateways are minted by `bpmn_branch` (exclusive) and `bpmn_parallel`.

## Label what you add

`bpmn_branch` needs `label` for its conditional exit and `name` for the gateway, or the
lint gate refuses the write (`label-required`). Give every step a `name`. An unlabelled
model is a worse model, and the gate says so rather than letting it through.

## When to preview, and when the server says no

Editing a file you inherited: call the op with the default `dry_run: true`, read the
gates and the diff, then write. Growing a file you created in this session: write
directly; every gate still runs before the rename.

`THB_REQUIRES_APPROVAL` is not retryable. It means the edit's risk (`routing` for a
gateway or a condition, `destructive` for a removal) is above what this server may
write alone. Report the edit, its risk and the allowance to the user and stop; they
restart the server with `--allow` or `TREADLE_ALLOW` if they want it written.
````

Then extend the operation table (the `you want to | operation` block) with these rows above the existing ones:

```markdown
| create a process from nothing | `bpmn_create`, then the ops below |
| add a step after another | `bpmn_insert_after` — it splices the existing flow |
| a decision with two paths | `bpmn_branch` — with `label` |
| work done in parallel | `bpmn_parallel` |
| a deadline on a step | `bpmn_timeout` |
| what happens when a step fails | `bpmn_on_error` |
| skip a step, healing the chain | `bpmn_bypass` (destructive: needs approval) |
| rename, condition, lane | `bpmn_rename`, `bpmn_guard`, `bpmn_move_to_lane` |
```

- [ ] **Step 5: README**

In `README.md`, replace "The path-addressed server exposes five tools:" and the table with the sixteen tools (the five existing rows unchanged, then):

```markdown
The path-addressed server exposes sixteen tools. Five read and patch:

| tool | what it gives the model |
|---|---|
| … the five existing rows … |

One creates, and ten propose the named operations on a file, with an exact argument
schema each: `bpmn_create`, `bpmn_insert_after`, `bpmn_branch`, `bpmn_parallel`,
`bpmn_timeout`, `bpmn_on_error`, `bpmn_bypass`, `bpmn_guard`, `bpmn_rename`,
`bpmn_move_to_lane`, `bpmn_message`. An op tool is a dry run by default; with
`dry_run: false` and the `base_rev` you read, it writes when every gate passes and the
edit's risk is within `--allow` / `TREADLE_ALLOW` (default `safe,additive`).
`bpmn_create` refuses to overwrite. To load the server into another project on this
machine without publishing, see [plugin/README.md](plugin/README.md).
```

Also change the sentence "its npm-based setup requires package publication." to "it loads from this checkout in place; publication only changes one line."

---

### Task 7: The gate and the real runtime

- [ ] **Step 1: The gate**

Run: `make check`
Expected: lint clean, `tsc` twice clean, all tests pass, coverage `all files | 100.00 | 100.00 | 100.00`, corpus and replay green. Fix anything red before continuing; never lower a threshold.

- [ ] **Step 2: A scratch project, driven by a real Claude Code session**

```sh
SCRATCH=$(mktemp -d /tmp/scratch-bpmn.XXXX) && mkdir "$SCRATCH/processos" && cd "$SCRATCH" && git init -q
env -u CLAUDECODE claude -p \
  --plugin-dir /Users/nicollasisaacqueirozbatista/Documents/projetos/treadle/plugin/plugins/therblig \
  --allowedTools 'mcp__therblig__*' \
  'Crie o processo "Pedido" em processos/pedido.bpmn: conferir pedido, depois um gateway "Aprovado?" com separar (sim) e corrigir (não), um prazo de 2 dias na conferência que vai para o fim, e um tratamento de erro na conferência. Use só as tools do therblig e no fim rode bpmn_lint.'
```

Expected: the file exists, `bpmn_lint` reports zero errors, the transcript shows only `bpmn_create` and `bpmn_<op>` writes. If the `claude` binary refuses to run nested, run the same prompt in a separate terminal and paste the tool list into the finding; the smoke test in Task 5 is the automated proof.

- [ ] **Step 3: CLI and Studio on the created file**

```sh
node backend/cli/main.mjs lint "$SCRATCH/processos/pedido.bpmn" --root "$SCRATCH"
node backend/cli/main.mjs explain "$SCRATCH/processos/pedido.bpmn" --root "$SCRATCH"
PORT=3106 make dev WORKSPACE="$SCRATCH"   # then curl -s http://localhost:3106/p/processos/pedido.bpmn | grep -o 'all gates pass'
```

Expected: five `ok` lines; the explain names the steps; the Studio page says `all gates pass`.

- [ ] **Step 4: Refusal on a destructive ask**

In the same scratch session ask to remove "Corrigir". Expected: the agent reports `THB_REQUIRES_APPROVAL` and the file's `base_rev` is unchanged (`bpmn_read` before and after).

---

### Task 8: Records

**Files:**
- Modify: `docs/DECISIONS.md` (new ADR-013 before the `---` that precedes "Package names and implementation status…"), `docs/FINDINGS.md` (append Studio F18), `docs/DEFERRED.md` (two entries)

- [ ] **Step 1: ADR-013**

```markdown
## ADR-013 — Creation is a seed plus the same operations

`bpmn_create` writes the smallest valid process — a start and an end, connected, with
DI — and nothing else is ever generated from nothing. Growth goes through the named
operations, each with its gates, exact inverse and computed risk, so a file the agent
created is held to the same barrier as a file the user inherited.

**Rests on:** Studio F18. A seed built through `applyPatch` and `placeNew` passes all
five gates at 27 lines; from it the ops built a 10-node process with a gateway, a timer
and an error handler, five gates green. Two refusals shaped it: a seed holding only a
start event cannot take a first step (`no-implicit-end`), so the seed is born connected;
and `branch` without `label` fails the differential lint gate, so the skill says to
label. ADR-003 stands: edit-first, and the seed is the one exception, sized to be
harmless.

**The named ops arrive on the path-addressed server (ADR-010 rev. 2 amended).** One
tool per op, `bpmn_<op>`, each with the exact argument schema `tools.mjs` declares
(Studio F15), sharing one stateless handler: read with rev, compile the op, `propose`,
and on a write require the current `base_rev`, every gate green and a risk within the
allowance. The handle server keeps its copy for the Studio and the bench until they
migrate; see DEFERRED.

**The allowance is the server's, in one place.** `allowanceOf` moved to the core beside
`risk`; the CLI's `--allow`, the binary's `--allow`/`TREADLE_ALLOW` and `bpmn_patch`
all read it. Creation is outside it: it changes nothing that exists, and `wx` is the
primitive that cannot overwrite.

**Reverses if:** a caller needs pools, lanes or a collaboration from nothing. That is a
second seed shape with its own DI, and a decision about what a message flow may cross.
```

- [ ] **Step 2: Studio F18**

Append to `docs/FINDINGS.md`, filled with the numbers Task 7 actually produced:

```markdown
## Studio F18 — a two-node seed grows into a real process, and two gates decide its shape

Measured 2026-09-23 on the local checkout, Node 22.23.1.

A seed built by the core — start, end, one flow, an empty plane, `placeNew` — serializes
to 27 lines and passes `parses`, `xsdValid`, `references`, `semantics` and `lintClean`,
with `diCoverage` 3 of 3. From it, `insertAfter` ×2, `branch`, `timeout` and `onError`
produced a 10-node process in 139 lines with five gates green and an SVG from `render`.

Two refusals along the way are the design: on a seed holding only a start event,
`add` + `connect` of one task is refused with `no-implicit-end`; `branch` without
`label` is refused with `label-required:Flow_Yes_in` on the seed and on MIWG C.9.0
alike. The seed is therefore born connected, and the skill tells the agent to label.

The CLI's `--allow routing` then refused an additive `parallel`: the flag replaces the
allowance rather than extending it, which the MCP binary and the skill now state.

Real runtime, <fill: Claude Code version>, `--plugin-dir` from the checkout: the prompt in
the plan produced `processos/pedido.bpmn` in <fill: N> tool calls, all of them
`bpmn_create` or `bpmn_<op>`; `bpmn_lint` reported 0 errors; the Studio showed all gates
passing. A request to remove a step was answered with `THB_REQUIRES_APPROVAL` and the
file's revision did not change.

Reproduce:

```sh
node --test backend/test/unit/seed.test.mjs backend/test/smoke/therblig-mcp.test.mjs
```
```

- [ ] **Step 3: DEFERRED**

Append to `docs/DEFERRED.md`:

```markdown
## Pools and lanes from nothing

`bpmn_create` seeds one process. A collaboration with pools, lanes and message flows is a
different seed shape with its own DI, and a decision about what may cross a pool.

**Trigger:** the first request for a new multi-pool process. Until then the agent creates
the process and the user adds pools in a modeller, which keeps the existing DI.

## Two MCP servers, two io stacks

`therblig-mcp` (path-addressed) now carries every named op; `treadle-mcp` (handles) keeps
its copy because the Studio and the bench call it, and `backend/io/paths.mjs` and
`backend/io/bpmn-file.mjs` each confine in their own way.

**Trigger:** the Studio and the bench harness no longer spawn `server.mjs`'s `build`.
Then `treadle-mcp`, `store.mjs`, `toolsFor` and `bpmn-file.confine` go, and one server
remains.
```

- [ ] **Step 4: Final gate and review**

Run: `make check && git diff --check && git status --short`
Then review the whole diff as an adversarial maintainer: no document content in errors, no path escapes, temp files cleaned, `tools/list` fixed, coverage 100%, no generated files staged, no secrets.
