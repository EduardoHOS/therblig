// An arm is an allowlist and nothing else. Everything else about a cell — the model, the effort,
// the prompt, the fixture, the scoring — is identical, so a difference between two arms is
// attributable to one thing: the tool surface the agent was given.

const RAW = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
// Off in every arm: a shell or a fetch would let an agent reach outside the cell, and the
// comparison is only honest if all three are confined to the same scratch copy.
const OUTSIDE = ['Bash', 'BashOutput', 'KillShell', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit'];

const READ = ['open', 'project', 'explain', 'lint'].map((name) => `mcp__treadle__${name}`);
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
].map((name) => `mcp__treadle__${name}`);

export const arms = {
  // A: what an ordinary coding agent does today — open the XML and edit it.
  raw: { allowedTools: RAW, disallowedTools: OUTSIDE },
  // B: isolates the question. Does the gain come from *seeing* a coordinate-free IR, or from
  // *writing* through a patch API? B sees the IR and still writes XML by hand.
  raw_ir: { allowedTools: [...RAW, ...READ], disallowedTools: OUTSIDE },
  // C: the product. No file tools at all — the agent cannot express an edit except as a patch.
  treadle: { allowedTools: [...READ, ...OPS], disallowedTools: [...RAW, ...OUTSIDE] },
};

export const armNames = Object.keys(arms);
