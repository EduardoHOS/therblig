// XSD and lint validation, resolved relative to THIS FILE rather than the cwd.
//
// bench/scorer/gates.mjs reads its schemas from `third_party/omg`, a bare relative
// path, which works exactly as long as the process was started from the repo root. In
// a published CLI it is a guaranteed ENOENT — and xsdValid's own catch turns that into
// `{ ok: false }`, so every file in the world would be reported invalid, with a message
// nobody would read closely. The cwd-independence CI job exists for this one bug.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as xmllint from 'xmllint-wasm';
import { BpmnModdle } from 'bpmn-moddle';

const OMG_DIR = fileURLToPath(new URL('../../third_party/omg/', import.meta.url));
const SCHEMA_FILES = ['BPMN20.xsd', 'Semantic.xsd', 'BPMNDI.xsd', 'DI.xsd', 'DC.xsd'];

let preload = null;
function schemas() {
  if (!preload) {
    preload = SCHEMA_FILES.map((f) => ({ fileName: f, contents: readFileSync(join(OMG_DIR, f), 'utf8') }));
  }
  return preload;
}

/** Does bpmn-moddle read it at all? */
export async function parses(xml) {
  try {
    const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
    return { ok: true, warnings: warnings.length, root: rootElement };
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${e.message.slice(0, 200)}` };
  }
}

/** Does it validate against the five OMG schemas? */
export async function xsdValid(xml) {
  try {
    const res = await xmllint.validateXML({
      xml: [{ fileName: 'doc.bpmn', contents: xml }],
      schema: [readFileSync(join(OMG_DIR, 'BPMN20.xsd'), 'utf8')],
      preload: schemas(),
    });
    return {
      ok: res.valid,
      errors: (res.errors || []).slice(0, 10).map((e) => (typeof e === 'string' ? e : e.message || e.rawMessage)),
    };
  } catch (e) {
    return { ok: false, errors: [`validator error: ${e.message.slice(0, 200)}`] };
  }
}

/** Proof the schemas are reachable from wherever this process was started. */
export function schemaDir() {
  return OMG_DIR;
}
