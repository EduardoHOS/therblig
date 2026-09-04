// The error taxonomy an agent sees.
//
// Every one of these is a TOOL EXECUTION error (isError: true on the MCP side), never
// a JSON-RPC protocol error. ADR-010 rev. 2: a stale revision or a missing file is a
// fact about the world, not a malformed request, and the model needs to read it and
// recover rather than have the transport reject it.
//
// Each code carries a recovery line, because the whole point of the message set is
// that the reader knows what to do next. Same three-part discipline as the oracle:
// what happened, why, what to do.

export const CODES = {
  THB_NOT_FOUND: 'The file does not exist. Check the path, or list the directory first.',
  THB_OUTSIDE_ROOT: 'The path is outside the directory this server was started in. Pass a path inside --root.',
  THB_NOT_BPMN: 'Only .bpmn and .xml files can be opened. Rename the file, or point at a different one.',
  THB_PARSE_FAILED: 'The file is not readable as BPMN 2.0 XML. Fix the XML, or check it is really a BPMN file.',
  THB_NO_DI: 'The file has no diagram interchange, so there is nothing to place new elements next to. Open it in a modeller and save it once, or edit a file that has been laid out.',
  THB_STALE_REV: 'The file changed since you read it. Read it again and reapply your edit to the new revision.',
  THB_REV_REQUIRED: 'A write needs the base_rev you got from reading the file, so a concurrent change cannot be overwritten silently.',
  THB_FORBIDDEN_FIELD: 'That field cannot be set directly. Adjacency lives on both the flow and its endpoints, so writing one side corrupts the graph.',
  THB_UNKNOWN_TYPE: 'That element type is not one this tool can create. See the type list in the tool description.',
  THB_NOT_FOUND_ELEMENT: 'No element with that id is in this file. Read the file to see the ids it actually has.',
  THB_REFUSED: 'The edit was not written because it would have changed more than you asked for. Nothing on disk was touched.',
  THB_WRITE_DISABLED: 'This version previews edits but does not write them. Pass dry_run: true to see the diff.',
};

export class TherbligError extends Error {
  /**
   * @param {keyof typeof CODES} code
   * @param {string} [detail] what specifically went wrong, in the product voice
   */
  constructor(code, detail) {
    const recovery = CODES[code];
    if (!recovery) throw new Error(`unknown error code "${code}"`);
    // One period between the two clauses — the detail comes from a throw site that
    // does not always punctuate itself, and "not found No element with that id" is
    // the kind of seam that makes a tool feel unfinished.
    const said = detail ? (/[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`) : null;
    super(said ? `${said} ${recovery}` : recovery);
    this.name = 'TherbligError';
    this.code = code;
    this.detail = detail ?? null;
    this.recovery = recovery;
  }

  /** The shape every MCP tool returns on failure. */
  toResult() {
    return { ok: false, code: this.code, error: this.message };
  }
}

export const fail = (code, detail) => { throw new TherbligError(code, detail); };
