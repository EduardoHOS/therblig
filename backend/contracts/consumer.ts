// Proves the emitted contracts are what they claim to be. It is type-checked and never executed —
// which is why it lives outside backend/test/, where the node test runner would try to run it.
// Every @ts-expect-error below is itself a guard: if the type it violates ever widened, tsc would
// report the directive as unused and `npm run types` would fail.
// Resolved the way a consumer of the published package would resolve it: through the emitted
// declarations, not through the JavaScript they were emitted from.
import type { Envelope, Operation, Projection, RiskLevel } from 'therblig';
import { insertAfter, propose, risk } from 'therblig';

declare const ir: Projection;

const envelope: Envelope = insertAfter(ir, {
  anchor: 'Charge',
  step: { type: 'user', name: 'Verify' },
});

const level: RiskLevel = envelope.risk;
const plan: Operation[] = envelope.plan;
const inverse: Operation[] = envelope.inverse;
const minted: string[] = envelope.minted;
const explanation: string = envelope.explain;

// The four primitives are a closed union: an op name is not one of them.
const add: Operation = { op: 'add', type: 'user', in: 'P' };
const set: Operation = { op: 'set', id: 'X', patch: { name: 'Y' } };
const del: Operation = { op: 'del', id: 'X' };
const connect: Operation = { op: 'connect', from: 'A', to: 'B' };

// @ts-expect-error an op is not a primitive: `rename` never reaches applyPatch.
const wrong: Operation = { op: 'rename', id: 'X', name: 'Y' };

// @ts-expect-error a risk level is a closed set.
const bogus: RiskLevel = 'catastrophic';

// @ts-expect-error insertAfter needs an anchor.
const missing = insertAfter(ir, { step: { type: 'user' } });

export const surface = {
  level,
  plan,
  inverse,
  minted,
  explanation,
  primitives: [add, set, del, connect],
  computed: risk,
  dryRun: propose,
  unused: [wrong, bogus, missing],
};
