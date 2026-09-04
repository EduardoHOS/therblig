// The MCP server. Five tools, stdio only, no protocol sessions.
//
// ADR-010 rev. 2: every tool takes a path as an ordinary argument and the server holds
// no cross-call state. Consistency travels in `base_rev` — the first 12 hex of the
// SHA-256 of the file's bytes — which every read returns and every write will require.
// No handles, no patch_id: a file on disk is already named by the filesystem, and
// re-reading it costs single-digit milliseconds.
//
// Everything here is READ-ONLY. bpmn_patch accepts dry_run: true and nothing else, so
// v0.1 has zero blast radius while still exercising the IR, the ops, the placement and
// the refusal messages against real files and real models.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { parse, serialize } from '../model.mjs';
import { project } from '../ir.mjs';
import { applyPatch } from '../patch.mjs';
import { placeNew } from '../place.mjs';
import { explain } from '../explain.mjs';
import { parses, xsdValid } from '../validate.mjs';
import { inspect } from '../oracle/inspect.mjs';
import { compare, blocking } from '../oracle/compare.mjs';
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
      'Preview an edit. Applies operations to the parsed document in memory, places any new ' +
      'elements next to their neighbours, and reports what would change — including anything ' +
      'that changed which you did not ask for. Writes nothing in this version: dry_run must be ' +
      'true. Operations: add, set, del, connect.',
    inputSchema: z.object({
      path: z.string(),
      ops: z.array(z.record(z.string(), z.any())).min(1)
        .describe('Patch operations, e.g. {"op":"add","type":"user","name":"Review","in":"<processId>","between":["<a>","<b>"]}'),
      dry_run: z.literal(true).describe('Must be true. This version previews edits and never writes.'),
      base_rev: z.string().optional()
        .describe('The revision you read. Not required for a dry run; required once writing exists.'),
    }),
  }, guard(async ({ path, ops, base_rev }) => {
    const { xml, rev } = await open(path);
    if (base_rev && base_rev !== rev) {
      throw new TherbligError('THB_STALE_REV', `You read ${base_rev}; the file is now ${rev}.`);
    }
    const doc = await parse(xml);
    const { changed, created } = applyPatch(doc, ops);
    const touched = [...new Set([...changed, ...created])];
    placeNew(doc, touched);
    const after = await serialize(doc);
    const diags = await compare(xml, after, { expectedIds: touched });
    const blockers = blocking(diags);
    return json({
      ok: blockers.length === 0,
      dry_run: true, base_rev: rev, written: false,
      created, changed,
      refused: blockers.length > 0,
      diagnostics: diags.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements, message: message(d) })),
    });
  }));

  return server;
}
