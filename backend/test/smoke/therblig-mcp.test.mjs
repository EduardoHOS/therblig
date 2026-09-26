import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { client, THERBLIG_BIN } from '../support/mcp-client.mjs';

const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));

// Fixed, and in this order: the five path-addressed tools, creation, then one tool per named op.
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
    const path = 'processos/pedido.bpmn';
    const made = await mcp.call('bpmn_create', {
      path, name: 'Pedido', start: 'Pedido recebido', end: 'Pedido concluído',
    });
    assert.equal(made.isError, false, made.text);
    assert.match(made.data.base_rev, /^[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(made.data.ids).sort(), ['definitions', 'end', 'flow', 'process', 'start']);
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

    const write = await mcp.call('bpmn_branch', {
      path: 'processos/x.bpmn', args, dry_run: false, base_rev: made.data.base_rev,
    });
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
    refused(
      await mcp.call('bpmn_rename', { path: 'p.bpmn', args, dry_run: false, base_rev: 'deadbeefcafe' }),
      'THB_STALE_REV',
    );
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
  const args = (start) => ({
    anchor: start, when: 'ok', name: 'Ok?', label: 'yes', yes: [{ type: 'task', name: 'Yes' }],
  });

  const strict = serve(cwd);
  try {
    const made = await strict.call('bpmn_create', { path: 'processos/a.bpmn', name: 'A' });
    const body = refused(
      await strict.call('bpmn_branch', {
        path: 'processos/a.bpmn', args: args(made.data.ids.start), dry_run: false, base_rev: made.data.base_rev,
      }),
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
    const ok = await viaEnv.call('bpmn_branch', {
      path: 'processos/a.bpmn', args: args(start), dry_run: false, base_rev: read.data.base_rev,
    });
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
    refused(
      await strict.call('bpmn_patch', { path: 'p.bpmn', ops, dry_run: false, base_rev: read.data.base_rev }),
      'THB_REQUIRES_APPROVAL',
    );
    const preview = await strict.call('bpmn_patch', { path: 'p.bpmn', ops });
    assert.equal(preview.isError, false, 'a preview is never refused for risk');
  } finally {
    strict.close();
  }
  const wide = serve(cwd, ['--allow', 'safe,additive,routing,destructive']);
  try {
    const read = await wide.call('bpmn_read', { path: 'p.bpmn', view: 'outline' });
    const ok = await wide.call('bpmn_patch', {
      path: 'p.bpmn', ops: [{ op: 'del', id: 'Charge' }], dry_run: false, base_rev: read.data.base_rev,
    });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.written, true);
  } finally {
    wide.close();
  }
});

test('bpmn_create refuses an existing file, a path outside the root, a .xml name, a missing parent and a blank name', async () => {
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
      await mcp.call('bpmn_insert_after', {
        path: 'processos/e.bpmn', args: { anchor: made.data.ids.end, step: { type: 'task' } },
      }),
      'THB_OP_REFUSED',
    );
    assert.equal(dangling.reason, 'anchor-no-outgoing');
    assert.match(dangling.error, /no outgoing flow/);
    const missing = refused(
      await mcp.call('bpmn_timeout', {
        path: 'processos/e.bpmn', args: { on: 'Nope', after: 'P1D', to: made.data.ids.end },
      }),
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
  const run = spawnSync(process.execPath, [THERBLIG_BIN, '--root', cwd, '--allow', 'safe,bogus'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown risk level "bogus"/);
  assert.equal(run.stdout, '');
});
