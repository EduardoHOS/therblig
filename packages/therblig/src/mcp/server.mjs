// The MCP server. Five tools, stdio only, no protocol sessions.
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
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { parse } from '../model.mjs';
import { project } from '../ir.mjs';
import { applyToFile } from '../write.mjs';
import { explain } from '../explain.mjs';
import { parses, xsdValid } from '../validate.mjs';
import { inspect } from '../oracle/inspect.mjs';
import { message } from '../oracle/invariants.mjs';
import { readWithRev } from '../rev.mjs';
import { confine } from '../paths.mjs';
import { TherbligError } from '../errors.mjs';

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

/**
 * @param {string} root absolute, already realpath'd
 */
export function createServer(root) {
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
      destructiveHint: false,
      idempotentHint: false,
    },
  }, guard(async ({ path, ops, dry_run, base_rev }) => {
    const abs = await confine(root, path);
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

  return server;
}
