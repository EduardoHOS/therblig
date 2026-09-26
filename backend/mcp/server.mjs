#!/usr/bin/env node
// The path-based MCP server. Five tools, stdio only, no protocol sessions.
//
// ADR-010 rev. 2: every tool takes a path as an ordinary argument and the server holds
// no cross-call state. Consistency travels in `base_rev` — the first 12 hex of the
// SHA-256 of the file's bytes — which every read returns and every write requires.
// No handles, no patch_id: a file on disk is already named by the filesystem, and
// re-reading it costs single-digit milliseconds.
//
// Four tools are read-only. bpmn_patch previews by default and writes only when asked
// with dry_run: false AND the base_rev the caller was given — so an edit built against
// bytes that have since changed on disk is refused rather than overwriting a save from
// somebody's modeller. A refused edit never opens the file for writing at all.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { parse, serialize } from '../core/document.mjs';
import { allowanceOf, risk } from '../core/ops.mjs';
import { project } from '../core/projection.mjs';
import { propose } from '../core/propose.mjs';
import { seed } from '../core/seed.mjs';
import { createBpmn } from '../io/bpmn-file.mjs';
import { applyToFile, atomicWrite } from '../io/write.mjs';
import { explain } from '../explain.mjs';
import { parses, xsdValid } from '../io/validate.mjs';
import { inspect } from '../oracle/inspect.mjs';
import { message } from '../oracle/invariants.mjs';
import { readWithRev, revOf } from '../io/rev.mjs';
import { confine } from '../io/paths.mjs';
import { TherbligError } from '../io/errors.mjs';
import { createStore } from './store.mjs';
import { ARGS, OPS, toolsFor } from './tools.mjs';

// Existing treadle clients use handles, revisions, and publish policy. Keep this
// contract in its own server so therblig's five path-based tools remain stateless.
const AUTONOMOUS = new Set((process.env.TREADLE_ALLOW ?? 'safe,additive').split(','));

export function build({ root = process.cwd(), autonomous = AUTONOMOUS } = {}) {
  const store = createStore({ root });
  const server = new McpServer(
    { name: 'treadle', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  for (const tool of toolsFor({ store, root, autonomous })) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema) },
      async (input) => {
        try {
          const result = await tool.handler(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
          // Never a stack, never document content: the model gets the rule and the remedy.
          const code = error.code ?? 'error';
          const text = error.message.startsWith(`${code}:`) ? error.message : `${code}: ${error.message}`;
          return { content: [{ type: 'text', text }], isError: true };
        }
      },
    );
  }

  return server;
}

const json = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

// Every failure is a TOOL EXECUTION error, never a protocol error: a stale revision or
// a missing file is a fact about the world that the model should read and recover from.
const failed = (e) => ({
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify(
      e instanceof TherbligError ? e.toResult() : { ok: false, code: 'THB_PARSE_FAILED', error: e.message },
      null, 2),
  }],
});

const guard = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { return failed(e); }
};

// io throws coded plain Errors for the file it creates; the agent needs the taxonomy.
const CREATE_CODES = {
  'not-bpmn': 'THB_NOT_BPMN',
  'path-outside-root': 'THB_OUTSIDE_ROOT',
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
 * @param {{allowance?: Set<string>}} [options] the risk levels a write may reach on its own
 */
export function createServer(root, { allowance = allowanceOf(process.env.TREADLE_ALLOW) } = {}) {
  const server = new McpServer({ name: 'therblig', version: '0.1.0' });
  const open = async (path) => {
    const abs = await confine(root, path);
    const { xml, rev } = await readWithRev(abs);
    return { abs, xml, rev };
  };

  server.registerTool('bpmn_read', {
    description:
      'Read a .bpmn file as a compact projection: nodes, flows, lanes and pools by id, with no ' +
      'coordinates. Roughly an order of magnitude smaller than the XML. Returns base_rev, which ' +
      'identifies the exact bytes you read.',
    inputSchema: z.object({
      path: z.string().describe('Path to a .bpmn file, absolute or relative to the server root.'),
      view: z.enum(['full', 'outline']).default('full')
        .describe('outline returns pools, lanes and node names only — use it first on an unfamiliar file.'),
    }),
  }, guard(async ({ path, view }) => {
    const { xml, rev } = await open(path);
    const { definitions } = await parse(xml);
    const ir = project(definitions);
    if (view === 'outline') {
      return json({
        ok: true, base_rev: rev,
        pools: ir.pools ?? [], lanes: ir.lanes ?? [],
        nodes: (ir.nodes ?? []).map((n) => ({ id: n.id, type: n.type, name: n.name ?? null })),
      });
    }
    return json({ ok: true, base_rev: rev, ...ir });
  }));

  server.registerTool('bpmn_explain', {
    description:
      'Explain what a process does: counts, control-flow complexity, and a Mermaid diagram. ' +
      'Use this before reading the full projection when you only need to understand the shape.',
    inputSchema: z.object({
      path: z.string(),
      max_nodes: z.number().int().min(1).max(400).default(60)
        .describe('Cap on nodes drawn in the diagram; the counts always cover the whole file.'),
    }),
  }, guard(async ({ path, max_nodes }) => {
    const { xml, rev } = await open(path);
    const r = await explain(xml, { maxNodes: max_nodes });
    return json({
      ok: true, base_rev: rev, headline: r.headline,
      summary: r.summary, mermaid: r.diagram.text, truncated: r.diagram.truncated,
    });
  }));

  server.registerTool('bpmn_lint', {
    description:
      'Check a file against BPMN rules the XSD cannot express: unreachable nodes, cross-pool ' +
      'sequence flows, duplicate ids, gateway branches with no condition. Each finding names the ' +
      'rule it breaks and the fix. Errors mean the file is broken; warnings mean it is legal and ' +
      'probably wrong.',
    inputSchema: z.object({ path: z.string() }),
  }, guard(async ({ path }) => {
    const { xml, rev } = await open(path);
    const d = await inspect(xml);
    return json({
      ok: true, base_rev: rev,
      errors: d.filter((x) => x.severity === 'error').length,
      warnings: d.filter((x) => x.severity === 'warning').length,
      diagnostics: d.map((x) => ({ code: x.code, severity: x.severity, elements: x.elements, message: message(x) })),
    });
  }));

  server.registerTool('bpmn_verify', {
    description:
      'Check that a file parses and validates against the five OMG BPMN 2.0 schemas. ' +
      'Use this to confirm a file is well-formed before trusting anything else about it.',
    inputSchema: z.object({ path: z.string() }),
  }, guard(async ({ path }) => {
    const { xml, rev } = await open(path);
    const p = await parses(xml);
    const x = p.ok ? await xsdValid(xml) : { ok: false, errors: [p.error] };
    return json({ ok: p.ok && x.ok, base_rev: rev, parses: p.ok, xsd_valid: x.ok, errors: x.errors ?? [] });
  }));

  server.registerTool('bpmn_patch', {
    description:
      'Edit a file. Applies operations to the parsed document, places new elements next to their ' +
      'neighbours, and checks the result against the original before anything is written — if the ' +
      'edit changed something you did not ask for, it is refused and the file is left untouched. ' +
      'Defaults to a preview. Operations: add, set, del, connect.',
    inputSchema: z.object({
      path: z.string(),
      ops: z.array(z.record(z.string(), z.any())).min(1)
        .describe('Patch operations, e.g. {"op":"add","type":"user","name":"Review","in":"<processId>","between":["<a>","<b>"]}'),
      dry_run: z.boolean().default(true)
        .describe('true previews and writes nothing. false writes, and then base_rev is required.'),
      base_rev: z.string().optional()
        .describe('The revision you were given when you read the file. Required to write, so an edit built against bytes that have since changed is refused rather than overwriting them.'),
    }),
    annotations: {
      readOnlyHint: false,
      // True, and it was false here for the wrong reason. The guard refuses edits that
      // change more than was asked — but this annotation is not a claim about the guard,
      // it is what a client reads to decide whether to ask the human first. applyToFile
      // renames over the original with no backup, and `del` removes elements. A model
      // can read a file and write it in consecutive turns; the prompt is the only thing
      // in between. The spec default is true, so false was an active suppression.
      destructiveHint: true,
      idempotentHint: false,
    },
  }, guard(async ({ path, ops, dry_run, base_rev }) => {
    const abs = await confine(root, path);
    // Risk is judged on the primitives as given. An operation `risk` does not know is left for
    // applyToFile, which refuses it with THB_UNKNOWN_TYPE and the same message it always had.
    if (dry_run === false) {
      let level = null;
      try { level = risk(ops); } catch { level = null; }
      if (level) refuseAbove(allowance, level);
    }
    const r = await applyToFile(abs, ops, { baseRev: base_rev ?? null, dryRun: dry_run !== false });
    return json({
      ok: !r.refused,
      dry_run: dry_run !== false,
      base_rev: r.base_rev,
      new_rev: r.new_rev ?? null,
      written: r.written,
      refused: r.refused,
      created: r.created,
      changed: r.changed,
      diagnostics: r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements, message: message(d) })),
    });
  }));

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
      // A missing parent surfaces as the fs error from realpath, whose message carries the
      // absolute path; say what the agent can act on instead.
      if (error.code === 'EEXIST') {
        throw new TherbligError('THB_EXISTS', `"${path}" already exists — edit it instead, or pick another path`);
      }
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw new TherbligError('THB_NOT_FOUND', `The directory of "${path}" does not exist — create it first`);
      }
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

  const opTools = Object.keys(OPS)
    .map((name) => [toolNameOf(name), name])
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [toolName, name] of opTools) {
    server.registerTool(toolName, {
      description:
        `Propose a ${name} edit on a file. A dry run (the default) returns the plan, its exact ` +
        'inverse, the computed risk, every gate and the measured diff, and writes nothing. With ' +
        'dry_run false and the base_rev you read, the edit is written if every gate passes and its ' +
        "risk is within this server's allowance.",
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

  return server;
}

// Preserve the treadle-mcp executable without opening a second protocol stream when
// therblig-mcp imports createServer. Resolve npm's bin symlink before comparing.
let entrypoint;
if (process.argv[1] && process.argv[1] !== '-') {
  try {
    entrypoint = realpathSync(process.argv[1]);
  } catch (error) {
    // An importer may run from stdin or have removed its own script after loading.
    // Neither is this module's executable entrypoint.
    if (error.code !== 'ENOENT') throw error;
  }
}
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await serveStdio(() => build(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });
}
