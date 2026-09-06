import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SERVER = new URL('../../mcp/server.mjs', import.meta.url).pathname;
const CORPUS = new URL('../../../bench/corpus/', import.meta.url).pathname;

// Every request in revision 2026-07-28 carries these; there is no initialize handshake.
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'treadle-smoke', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

// A JSON-RPC client over stdio, so the test drives the real entrypoint the way a client does.
function client(cwd) {
  const child = spawn(process.execPath, [SERVER], { cwd });
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
