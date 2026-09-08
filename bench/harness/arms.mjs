// An arm is the tool surface its agent is given, and nothing else. Everything else about a cell —
// the model, the effort, the prompt, the fixture, the scoring — is identical, so a difference
// between two arms is attributable to one thing.
//
// The surface is decided by which server the arm receives, not by a permission list. Measured:
// `allowedTools` auto-approves rather than restricts, and naming an MCP tool in `disallowedTools`
// did not remove it from context either — arm A reached mcp__treadle__open under both.

const RAW = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
// Off in every arm: a shell or a fetch would let an agent reach outside the cell, and the
// comparison is only honest if all three are confined to the same scratch copy.
const OUTSIDE = ['Bash', 'BashOutput', 'KillShell', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit'];

const READ = ['open', 'project', 'explain', 'lint'];
const OPS = [
  'branch',
  'bypass',
  'guard',
  'insertAfter',
  'message',
  'moveToLane',
  'onError',
  'parallel',
  'patch',
  'publish',
  'rename',
  'timeout',
];

const prefixed = (names) => names.map((name) => `mcp__treadle__${name}`);

export const arms = {
  // A: what an ordinary coding agent does today — open the XML and edit it. No treadle server.
  raw: { tools: null, allowedTools: RAW, disallowedTools: OUTSIDE },
  // B: isolates the question the project rests on. Does the gain come from *seeing* a
  // coordinate-free IR, or from *writing* through a patch API? B sees the IR and still writes XML.
  raw_ir: { tools: READ, allowedTools: [...RAW, ...prefixed(READ)], disallowedTools: OUTSIDE },
  // C: the product. No file tools at all — the agent cannot express an edit except as a patch.
  treadle: {
    tools: [...READ, ...OPS],
    allowedTools: prefixed([...READ, ...OPS]),
    disallowedTools: [...RAW, ...OUTSIDE],
  },
};

export const armNames = Object.keys(arms);
