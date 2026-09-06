# The 20 edit tasks

**You write the prompts. I write the assertions.** That split is deliberate: assertions
are mechanical, but if I write the prompts too I will unconsciously write tasks my own
patch API happens to handle well, and the bake-off measures nothing.

> **What actually happened, 2026-09-06.** The maintainer directed the author of the API to
> write the prompts as well. The split above was therefore not honoured, and **any finding
> built on this set must say so.** Three things blunt the bias and none removes it:
>
> 1. The category and stratum grid below was fixed first, from this brief, before a single
>    prompt was written — so coverage is not a function of what the ops handle well.
> 2. Every prompt was written against the file's real content (`CORPUS-INVENTORY.md` and the
>    projected IR), not against the op catalogue.
> 3. Tasks known to be hard or impossible for the structured arm were kept on purpose. T20
>    lands on pools that share no collaboration, which `connect` refuses outright.
>
> Replacing this table with prompts from someone who has not read `backend/core/` is the only
> thing that removes the caveat. The assertions in `tasks.mjs` can stay as they are.

Write each prompt the way you would actually say it to an agent that has the file open.
Plain English. Don't name element ids, don't say "add a `bpmn:UserTask`" — say
"add a step where someone checks the documents". If the phrasing is slightly ambiguous,
that is realistic and fine; I'll write the assertion against the reasonable reading.

Element names and ids to write against are in
[CORPUS-INVENTORY.md](CORPUS-INVENTORY.md).

## Coverage to aim for

Spread the 20 across these, roughly evenly. The categories on the right are where each
arm is expected to break, which is the point.

| category | why it's in the set |
|---|---|
| insert a step in a sequence | the base case; splice sugar vs. three manual rewires |
| delete a step and heal the chain | naive editing leaves dangling flows |
| add a boundary event (timer or error) | attachment is a separate ref that text editing gets wrong |
| split a path on a condition | needs a new gateway plus two conditional flows |
| add a parallel branch and rejoin | the hardest structural edit |
| move a task to another lane | lane membership lives on the lane, not the node |
| rename something referenced downstream | a flow id appears three times in the XML |
| edit inside a subprocess | scoping — the edit must land in the right container |
| change a condition expression | small, but has to land on the right flow |
| add a message flow between pools | cross-pool: only message flows may cross |

## File selection

Pick deliberately across strata — the naive arm is expected to fail outright above
~15,000 tokens, and we need enough large-file tasks to see it.

- **small** (<15 nodes): `A.1.0`, `A.2.0`, `A.3.0`, `C.9.1`, `C.1.1`, `C.7.0`, `C.3.0`
- **medium** (15–50): `C.9.0`, `C.9.2`, `A.4.0`, `A.4.1`, `C.1.0`, `B.1.0`, `C.2.0`, `C.5.0`, `C.4.0`, `C.6.0`
- **large / over the tool-response cap**: `B.2.0` (94 nodes, ~35k tokens), `C.8.0` (~60k), `C.8.1` (~33k)

At least 6 tasks should target files above 15,000 tokens.

---

## The tasks

Two worked examples so the format is clear. Replace and extend to 20.

| # | file | ~tokens | category | prompt |
|---|---|---|---|---|
| T01 | `miwg/C.9.0.bpmn` | 9k | insert | After the credit score is fetched, add a step where an analyst reviews the score before the application is checked automatically. |
| T02 | `miwg/C.5.0.bpmn` | 31k | insert | Before the risk assessment gets documented, we want a second person to double-check it. Add that step. |
| T03 | `miwg/C.1.0.bpmn` | 19k | delete | We stopped keeping paper, so the step that archives the original invoice should go away. The flow around it has to still work. |
| T04 | `miwg/C.9.0.bpmn` | 9k | delete | Drop the step that sends the rejection — rejecting the application is enough on its own. |
| T05 | `miwg/C.9.2.bpmn` | 5k | boundary | The fraud check should give up after two days and go to the step that accelerates the decision. |
| T06 | `miwg/C.8.1.bpmn` | 36k | boundary | If fetching the vacation information fails, do not leave it hanging — send the employee the refusal notice. |
| T07 | `miwg/C.9.1.bpmn` | 3k | split | We only want to send the reminder email when the customer has missed the deadline. Otherwise the process should carry straight on. |
| T08 | `miwg/C.3.0.bpmn` | 14k | split | After we analyse the customer request, check whether the appliance is still under warranty before we pick a service level. |
| T09 | `miwg/C.7.0.bpmn` | 12k | parallel | While the advertisement is being published on the homepage, we should also post it to the internal jobs board. Both have to finish before the vacancy counts as advertised. |
| T10 | `miwg/C.4.0.bpmn` | 27k | parallel | Once the responsible department starts preparing for the new employee, ordering the laptop and booking the desk should happen at the same time, and we wait for both. |
| T11 | `miwg/C.7.0.bpmn` | 12k | lane | Completing the advertisement should be the hiring manager's job, not recruitment's. |
| T12 | `miwg/C.5.0.bpmn` | 31k | lane | Checking the customer documents belongs with the Head of Market Service, not with the account manager. |
| T13 | `miwg/C.1.1.bpmn` | 11k | rename | We have gone English-only: "Rechnung klären" should read "Clarify invoice". |
| T14 | `miwg/B.2.0.bpmn` | 39k | rename | "User Task 3" should be called "Verify submission" from now on. |
| T15 | `miwg/A.4.0.bpmn` | 7k | subprocess | Inside the first expanded sub-process, add a step right after Task 4 and before that sub-process ends. |
| T16 | `miwg/C.6.0.bpmn` | 19k | subprocess | Inside "Make Booking", add a step that records the booking reference right after the flight is booked. |
| T17 | `miwg/C.1.0.bpmn` | 19k | condition | An invoice should only need approval above 1000 euros. Update the condition on the approved path to say so. |
| T18 | `miwg/C.8.1.bpmn` | 36k | condition | The approval path should also let through anything already marked pre-approved. Widen that condition. |
| T19 | `miwg/C.2.0.bpmn` | 12k | message | The carrier should tell the customer once the truck has been loaded. |
| T20 | `miwg/C.4.0.bpmn` | 27k | message | Payroll should let IT know once the employee has been registered, so the accounts can be created. |

Ten of the twenty are on files above 15,000 tokens, which the brief asks for: T02, T03, T06,
T10, T12, T14, T16, T17, T18, T20.

---

## What happens next

Each row is an entry in [`tasks.mjs`](tasks.mjs), with a mechanical assertion beside it:

```js
{
  id: 'T01',
  file: 'miwg/C.9.0.bpmn',
  prompt: 'After the credit score is fetched, add a step where an analyst reviews …',
  // Machine-checkable. Runs against the projected IR of whatever the arm produced.
  check(ir) {
    const added = ir.nodes.filter(n => !BASELINE_IDS.has(n.id));
    assert(added.length === 1, 'exactly one node added');
    assert(/review|analyst/i.test(added[0].name), 'named for what it does');
    assert(isBetween(ir, 'ServiceTask_GetCreditScore', added[0].id, 'ExclusiveGateway_Decision'),
           'sits between the credit score task and the decision gateway');
  },
}
```

Every assertion is checked to reject the file it starts from — an assertion that passes without
an edit measures nothing — and that check is a test, not a habit
(`backend/test/integration/replay.test.mjs`).

Then all three arms run the same 20 tasks and are scored by the same gates, now in
[`backend/core/gates.mjs`](../../backend/core/gates.mjs). Decision rules were committed in advance
and are in [../../docs/DECISIONS.md](../../docs/DECISIONS.md).

## Running it

```sh
cp .env.example .env          # then fill in ANTHROPIC_API_KEY
npm run bench:agent -- --tasks T04,T13 --arms raw,treadle --runs 1 --yes
npm run bench:replay          # free, offline, and part of `npm run check`
```

`bench:agent` spends real money and refuses to start without a per-cell budget and `--yes`.
`bench:replay` reads what it recorded and scores it, so any number this produces is reproducible
by someone with the repository and no API key.
