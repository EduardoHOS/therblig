import 'server-only';

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import {
  changesFrom,
  lintClean,
  parse,
  parses,
  project,
  references,
  render,
  review,
  semantics,
  xsdValid,
} from 'therblig';

// The workspace is a directory of .bpmn files on this machine. No account, no upload, no server
// but this one — the files stay where they are and the browser only ever sees a projection.
export const ROOT = resolve(process.env.TREADLE_WORKSPACE ?? join(process.cwd(), '..'));

export type Gate = { name: string; ok: boolean; detail: string };
export type Entry = { path: string; nodes: number; pools: number; bytes: number };

/** Refuses anything outside the workspace, by real path, before it is opened. */
export async function confined(path: string): Promise<string> {
  const absolute = resolve(ROOT, path);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) {
    throw new Error(`"${path}" is outside the workspace`);
  }
  return absolute;
}

async function walk(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, found);
    else if (entry.name.endsWith('.bpmn')) found.push(path);
  }
  return found;
}

export async function list(): Promise<Entry[]> {
  const files = await walk(ROOT);
  const entries = await Promise.all(
    files.map(async (path) => {
      const xml = await readFile(path, 'utf8');
      const ir = project((await parse(xml)).definitions);
      return {
        path: relative(ROOT, path).split(sep).join('/'),
        nodes: ir.nodes?.length ?? 0,
        pools: ir.pools?.length ?? 0,
        bytes: (await stat(path)).size,
      };
    }),
  );
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function open(path: string, against?: string) {
  const xml = await readFile(await confined(path), 'utf8');
  const document = await parse(xml);
  const ir = project(document.definitions);

  const other = against ? await readFile(await confined(against), 'utf8') : null;
  const changed = other ? await changesFrom(other, xml) : {};

  const [g1, g2, g3, g4] = await Promise.all([
    parses(xml),
    xsdValid(xml),
    references(xml),
    semantics(xml),
  ]);
  const g5 = await lintClean(xml, { config: { extends: 'bpmnlint:correctness' } });

  const gates: Gate[] = [
    { name: 'parses', ok: g1.ok, detail: g1.ok ? '' : String(g1.error) },
    { name: 'xsd', ok: g2.ok, detail: (g2.errors ?? []).join('; ') },
    { name: 'references', ok: g3.ok, detail: (g3.findings ?? []).map((f) => f.rule).join(', ') },
    { name: 'semantics', ok: g4.ok, detail: (g4.findings ?? []).map((f) => f.rule).join(', ') },
    { name: 'bpmnlint', ok: g5.ok, detail: (g5.errors ?? []).map((e) => e.rule).join(', ') },
  ];

  return {
    path,
    against: against ?? null,
    ir,
    gates,
    changed,
    svg: render(document.definitions, { changed }),
    packet: other ? await review(other, xml, {}) : null,
  };
}
