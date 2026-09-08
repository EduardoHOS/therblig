import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = fileURLToPath(new URL('../../mcp/server.mjs', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));

// Every request in revision 2026-07-28 carries these; there is no initialize handshake.
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'treadle-smoke', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

// A JSON-RPC client over stdio, so the test drives the real entrypoint the way a client does.
function client(cwd, server = SERVER) {
  const child = spawn(process.execPath, [server], { cwd });
  const pending = new Map();
  const stdout = [];
  let stderr = '';
  let buffer = '';
  let id = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      stdout.push(line);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params: { _meta: META, ...params } })}\n`);
    });

  return {
    list: () => send('tools/list', {}),
    call: async (name, args) => {
      const message = await send('tools/call', { name, arguments: args });
      if (message.error) return { protocolError: message.error };
      const { content, isError } = message.result;
      const text = content[0].text;
      return { isError: isError ?? false, text, data: isError ? undefined : JSON.parse(text) };
    },
    stdout: () => stdout,
    stderr: () => stderr,
    close: () => child.kill(),
  };
}

async function workspace(fixture = 'handmade/zeebe-roundtrip.bpmn') {
  const cwd = await mkdtemp(join(tmpdir(), 'treadle-mcp-'));
  await cp(join(CORPUS, fixture), join(cwd, 'p.bpmn'));
  return cwd;
}

const read = (cwd) => readFile(join(cwd, 'p.bpmn'), 'utf8');

test('importing the public MCP module exports both factories without serving stdio', async () => {
  const cwd = await workspace();
  const source = `import { build, createServer } from ${JSON.stringify(pathToFileURL(SERVER).href)};
process.stdout.write(JSON.stringify([typeof build, typeof createServer]));`;
  const importer = join(cwd, 'import.mjs');
  await writeFile(importer, source);

  for (const args of [['--input-type=module', '--eval', source], [importer]]) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } })}\n`,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '["function","function"]');
    assert.equal(result.stderr, '');
  }
});

test('the compatibility entrypoint also serves through a package-bin symlink', { timeout: 10000 }, async () => {
  const cwd = await workspace();
  const linked = join(cwd, 'treadle-mcp');
  await symlink(SERVER, linked);
  const mcp = client(cwd, linked);
  try {
    const { result } = await mcp.list();
    assert.ok(result.tools.some((tool) => tool.name === 'open'));
    assert.ok(result.tools.some((tool) => tool.name === 'publish'));
    assert.ok(result.tools.every((tool) => !tool.name.startsWith('bpmn_')));
  } finally {
    mcp.close();
  }
});

test('stdin ESM scripts can import the public server without treating stdin as a file', () => {
  const source = `import { build, createServer } from ${JSON.stringify(pathToFileURL(SERVER).href)};
process.stdout.write(JSON.stringify([typeof build, typeof createServer]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    encoding: 'utf8', timeout: 10000, input: source,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '["function","function"]');
  assert.equal(result.stderr, '');
});

test('a removed host entrypoint does not prevent importing the public server', async () => {
  const cwd = await workspace();
  const source = `process.argv[1] = ${JSON.stringify(join(cwd, 'missing.mjs'))};
const { build, createServer } = await import(${JSON.stringify(pathToFileURL(SERVER).href)});
process.stdout.write(JSON.stringify([typeof build, typeof createServer]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 10000,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } })}\n`,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '["function","function"]');
  assert.equal(result.stderr, '');
});

test('tools/list is deterministic and offers reading, every op, and publishing', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const first = await mcp.list();
    const names = first.result.tools.map((tool) => tool.name);

    assert.deepEqual(names, [...names].sort(), 'deterministic order');
    for (const expected of ['open', 'project', 'explain', 'lint', 'patch', 'publish', 'insertAfter', 'branch']) {
      assert.ok(names.includes(expected), expected);
    }
    for (const tool of first.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.ok(tool.description.length > 0, tool.name);
    }

    const second = await mcp.list();
    assert.deepEqual(second.result.tools, first.result.tools);
  } finally {
    mcp.close();
  }
});

test('open mints an opaque handle and a revision, and project reads through it', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const opened = await mcp.call('open', { path: 'p.bpmn' });
    assert.equal(opened.isError, false);
    assert.match(opened.data.handle, /^[0-9a-f-]{36}$/, 'opaque, not a path');
    assert.doesNotMatch(opened.data.handle, /p\.bpmn/);
    assert.ok(opened.data.rev);

    const ir = await mcp.call('project', { handle: opened.data.handle });
    assert.deepEqual(
      ir.data.nodes.map((node) => node.id),
      ['Start_1', 'Charge', 'Review', 'End_1'],
    );
  } finally {
    mcp.close();
  }
});

test('an op is a dry run: it mints a revision and the file is untouched', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const before = await read(cwd);

    const proposed = await mcp.call('rename', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'a',
      args: { id: 'Charge', name: 'Charge the card' },
    });

    assert.equal(proposed.isError, false);
    assert.equal(proposed.data.risk, 'safe');
    assert.equal(proposed.data.explain, 'Renamed "Charge card" to "Charge the card".');
    assert.equal(proposed.data.ok, true);
    assert.notEqual(proposed.data.rev, opened.rev);
    assert.equal(proposed.data.gates.references.ok, true);
    assert.equal(await read(cwd), before, 'the file is untouched until publish');
  } finally {
    mcp.close();
  }
});

test('publish writes the revision, and only that revision', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const { data: proposed } = await mcp.call('rename', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'a',
      args: { id: 'Charge', name: 'Charge the card' },
    });

    const published = await mcp.call('publish', {
      handle: opened.handle,
      rev: proposed.rev,
      patch_id: 'b',
    });

    assert.equal(published.isError, false);
    assert.match(await read(cwd), /name="Charge the card"/);
    assert.deepEqual((await readdir(cwd)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    mcp.close();
  }
});

// Resumability is gone from the protocol, so a dropped stream means the client re-issues the
// call. Every mutating tool has to be idempotent or it double-applies the edit.
test('the same patch_id twice applies once and returns the same revision', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const args = { id: 'Charge', name: 'Charge the card' };

    const first = await mcp.call('rename', { handle: opened.handle, base_rev: opened.rev, patch_id: 'a', args });
    const again = await mcp.call('rename', { handle: opened.handle, base_rev: opened.rev, patch_id: 'a', args });

    assert.equal(first.data.rev, again.data.rev);
    assert.deepEqual(first.data, again.data);
  } finally {
    mcp.close();
  }
});

test('a stale base_rev is refused and names the revision that is current', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const { data: proposed } = await mcp.call('rename', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'a',
      args: { id: 'Charge', name: 'First' },
    });
    await mcp.call('publish', { handle: opened.handle, rev: proposed.rev, patch_id: 'b' });

    const stale = await mcp.call('rename', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'c',
      args: { id: 'Charge', name: 'Second' },
    });

    assert.equal(stale.isError, true);
    assert.match(stale.text, /stale-revision/);
    assert.match(stale.text, new RegExp(proposed.rev));
  } finally {
    mcp.close();
  }
});

test('a risk above the server policy is proposed but not published', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const before = await read(cwd);

    const proposed = await mcp.call('bypass', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'a',
      args: { id: 'Review' },
    });
    assert.equal(proposed.isError, false, 'proposing is always allowed');
    assert.equal(proposed.data.risk, 'destructive');

    const refused = await mcp.call('publish', {
      handle: opened.handle,
      rev: proposed.data.rev,
      patch_id: 'b',
    });

    assert.equal(refused.isError, true);
    assert.match(refused.text, /requires-approval/);
    assert.match(refused.text, /destructive/);
    assert.equal(await read(cwd), before);
  } finally {
    mcp.close();
  }
});

test('a precondition refusal is a tool error the model can act on, not a protocol error', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });

    const refused = await mcp.call('insertAfter', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'a',
      args: { anchor: 'End_1', step: { type: 'user' } },
    });

    assert.equal(refused.isError, true);
    assert.match(refused.text, /anchor-no-outgoing/);
    assert.match(refused.text, /use connect/);
    assert.doesNotMatch(refused.text, /at .*\.mjs:\d+/);
  } finally {
    mcp.close();
  }
});

test('an unknown handle and a path outside the root are refused as tool errors', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const unknown = await mcp.call('project', { handle: '00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /unknown-handle/);

    const escaped = await mcp.call('open', { path: '../escape.bpmn' });
    assert.equal(escaped.isError, true);
    assert.match(escaped.text, /outside the workspace/);
  } finally {
    mcp.close();
  }
});

test('stdout carries protocol and nothing else; logs go to stderr', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    await mcp.call('lint', { handle: opened.handle });
    await mcp.call('project', { handle: 'nope' });

    for (const line of mcp.stdout()) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', line.slice(0, 80));
    }
  } finally {
    mcp.close();
  }
});

// Found by the first valid bench cell: an agent retried bypass three times under one patch_id,
// guessing argument names, and then called publish with that same id. publish found the bypass
// result in the cache, returned it as its own, wrote nothing, and the agent believed it was done.
test('a patch_id is remembered per tool, so reusing one across tools cannot publish nothing', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { data: opened } = await mcp.call('open', { path: 'p.bpmn' });
    const { data: proposed } = await mcp.call('rename', {
      handle: opened.handle,
      base_rev: opened.rev,
      patch_id: 'same',
      args: { id: 'Charge', name: 'Charge the card' },
    });

    const published = await mcp.call('publish', {
      handle: opened.handle,
      rev: proposed.rev,
      patch_id: 'same',
    });

    assert.equal(published.isError, false);
    assert.equal(published.data.published, true, 'publish must publish, not echo the proposal');
    assert.match(await readFile(join(cwd, 'p.bpmn'), 'utf8'), /name="Charge the card"/);
  } finally {
    mcp.close();
  }
});

// Also from that cell: the agent could not know an op's argument names, because the tool declared
// only `args: object`. Each op now carries the real shape.
test('every op declares the arguments it takes, so the model does not have to guess', async () => {
  const cwd = await workspace();
  const mcp = client(cwd);
  try {
    const { result } = await mcp.list();
    const shapes = Object.fromEntries(result.tools.map((tool) => [tool.name, tool.inputSchema]));

    const argsOf = (name) => shapes[name].properties.args;
    assert.deepEqual(Object.keys(argsOf('bypass').properties), ['id']);
    assert.deepEqual(argsOf('bypass').required, ['id']);
    assert.deepEqual(Object.keys(argsOf('timeout').properties).sort(), ['after', 'name', 'on', 'to']);
    assert.deepEqual(argsOf('timeout').required.sort(), ['after', 'on', 'to']);
    assert.deepEqual(Object.keys(argsOf('guard').properties).sort(), ['default', 'flow', 'if']);
    assert.equal(argsOf('insertAfter').properties.step.type, 'object');
    assert.equal(argsOf('parallel').properties.branches.type, 'array');

    for (const name of ['bypass', 'timeout', 'rename', 'guard', 'message', 'branch', 'parallel']) {
      assert.equal(argsOf(name).additionalProperties, false, `${name} accepts unknown arguments`);
    }
  } finally {
    mcp.close();
  }
});
