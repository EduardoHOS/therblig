// The invariant table. Frozen list, one entry per rule the oracle can report.
//
// Deliberately separate from bench/scorer/gates.mjs. The gates score a benchmark; the
// oracle guards a write. Conflating the two is how F9 came to be trusted — a scorer
// written alongside the code it grades, from the same mental model, by the same
// author, and structurally blind to the failure it existed to catch (F11).
//
// Message shape is fixed at three parts, from the product brief: what is wrong with a
// count and a name, then the BPMN rule in one plain sentence, then the fix as a verb.
//
//   "1 task unreachable: invoice. Nothing flows into it. Connect it or remove it."
//    ^ what                       ^ rule                 ^ fix
//
// The rule clause is the point. A validator that says "invalid element" teaches
// nothing; one that says "sequence flows stay inside one pool" leaves the reader
// knowing BPMN slightly better than it found them.

/** @typedef {'error'|'warning'} Severity */

export const INVARIANTS = {
  // --- structural: these are what the XSD cannot check (F7's stated ceiling) ------
  DUPLICATE_ID: {
    severity: 'error',
    rule: 'Ids are unique in BPMN.',
    fix: 'Rename one.',
  },
  DANGLING_REF: {
    severity: 'error',
    rule: 'Every reference must resolve to an element in the file.',
    fix: 'Point it at an element that exists, or remove it.',
  },
  ADJACENCY_DESYNC: {
    severity: 'error',
    rule: 'A flow records its endpoints twice: on the flow, and on each node it touches.',
    fix: 'Rebuild the flow with connect, which writes both sides.',
  },
  DI_ORPHAN: {
    severity: 'error',
    rule: 'A shape must belong to an element that exists.',
    fix: 'Remove the shape.',
  },
  DI_MISSING: {
    severity: 'error',
    rule: 'Every element that renders needs a shape or an edge.',
    fix: 'Place it, or remove the element.',
  },

  // --- notation: legal BPMN, but almost always a mistake -------------------------
  //
  // These are WARNINGS here and ERRORS in the product brief, and the divergence is
  // deliberate. The brief specifies a UI where errors block publish, so it is free to
  // take a house position — "a pool starts in one place". The oracle guards a write to
  // somebody else's file, and multiple start events, an unlabelled branch and a missing
  // end event are all permitted by BPMN 2.0. A validator that calls legal notation an
  // error teaches the reader something untrue and gets muted.
  //
  // The split follows ADR-006, which already made exactly this call for bpmnlint:
  // `correctness` is a hard gate, `recommended` is a style opinion scored differentially.
  // Error = the file is structurally broken or violates the spec. Warning = the file is
  // legal and probably wrong.
  UNREACHABLE: {
    severity: 'warning',
    rule: 'Nothing flows into it.',
    fix: 'Connect it or remove it.',
  },
  CROSS_POOL_SEQUENCE_FLOW: {
    severity: 'error',
    rule: 'Sequence flows stay inside one pool.',
    fix: 'Use a message flow.',
  },
  INTRA_POOL_MESSAGE_FLOW: {
    severity: 'error',
    rule: 'Message flows only connect pools.',
    fix: 'Use a sequence flow.',
  },
  MULTIPLE_START_EVENTS: {
    severity: 'warning',
    rule: 'A pool starts in one place.',
    fix: 'Remove one, or merge them with a gateway.',
  },
  GATEWAY_ARITY: {
    severity: 'warning',
    rule: 'A gateway splits or joins, so it needs 2 or more.',
    fix: 'Add the missing branch, or remove the gateway.',
  },
  UNLABELLED_BRANCH: {
    severity: 'warning',
    rule: 'Each branch out of a gateway needs a condition.',
    fix: 'Name it, like yes or no.',
  },
  NO_END_EVENT: {
    severity: 'warning',
    rule: 'A pool with a task needs one, so a reader knows where it stops.',
    fix: 'Add one after the last task.',
  },

  // --- quality: legal, and worth saying out loud ---------------------------------
  NO_OUTGOING_FLOW: {
    severity: 'warning',
    rule: 'The process stalls here.',
    fix: 'Connect it, or end the process after it.',
  },
  EMPTY_LANE: {
    severity: 'warning',
    rule: 'Empty lanes export fine but read as missing work.',
    fix: 'Add a task or remove the lane.',
  },

  // --- preservation: relational, reported by compare() only ----------------------
  LABEL_DETACHED: {
    severity: 'error',
    rule: 'A label travels with the shape it names.',
    fix: 'Move the label by the same delta, or report the edit as a reflow.',
  },
  DIAGRAM_REFLOWED: {
    severity: 'error',
    rule: 'Making room moves everything by one delta; a relayout scatters them.',
    fix: 'Place incrementally instead of re-running layout.',
  },
  CONTENT_LOST: {
    severity: 'error',
    rule: 'An edit changes what you asked for and nothing else.',
    fix: 'Restore it, or name it in the expected set.',
  },
  UNEXPECTED_CHANGE: {
    severity: 'error',
    rule: 'An edit changes what you asked for and nothing else.',
    fix: 'Revert it, or name it in the expected set.',
  },
  COMMENT_LOST: {
    severity: 'warning',
    rule: 'moddle does not model comments, so a round-trip drops them (F10).',
    fix: 'Accept the reformat, or keep the comment out of the edited file.',
  },
};

/**
 * Compose a diagnostic into the one-sentence form the brief specifies.
 * `what` carries the count and the name; the table supplies rule and fix.
 */
export function message(d) {
  const inv = INVARIANTS[d.code];
  if (!inv) return d.what;
  return `${d.what} ${inv.rule} ${inv.fix}`;
}

/** Build a diagnostic. `what` is the only per-site prose; rule and fix are fixed. */
export function diag(code, what, elements = []) {
  const inv = INVARIANTS[code];
  if (!inv) throw new Error(`unknown invariant "${code}"`);
  return { code, severity: inv.severity, what, elements };
}

export const CODES = Object.keys(INVARIANTS);
