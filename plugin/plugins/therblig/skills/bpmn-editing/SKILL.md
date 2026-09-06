---
name: bpmn-editing
description: Use when reading, explaining, linting or editing a .bpmn file. Covers what BPMN's structure makes unsafe about ordinary text editing, and how to use the therblig tools instead.
---

# Editing BPMN files

A `.bpmn` file is XML, which makes it look editable with the same tools as any other
text. It is not, for four specific reasons. Each one has cost this project a bug.

## Never rewrite the whole file

Regenerating the document moves every shape, and the diff is unreviewable — nobody
approves a pull request that touched 1,700 lines to add one task. Use `bpmn_patch`,
which mutates the parsed document and rewrites only what changed. A one-attribute edit
comes out as a one-line diff with nothing moved.

## Adjacency is stored twice — never write one side

A sequence flow records its endpoints on the flow (`sourceRef`, `targetRef`) **and** on
each node it touches (`<incoming>`, `<outgoing>`). A find-and-replace on a flow id hits
three places and is ambiguous by construction; setting `targetRef` alone produces a file
that is XSD-valid and structurally a lie.

The tools refuse this: `set` will not write `sourceRef`, `targetRef`, `incoming`,
`outgoing`, `attachedToRef` or `flowNodeRef`. Use the operations instead.

| you want to | operation |
|---|---|
| add a step between two others | `add` with `between: [a, b]` — it rewires the existing flow for you |
| connect two nodes in one pool | `connect` |
| connect two nodes in **different** pools | `message` — only a message flow may cross a pool boundary |
| move a node to another lane | `move` — lane membership lives on the lane, not the node |
| remove something | `del` — it takes the attached flows and boundary events with it |

## Never re-run layout on a file that already has one

Full-file auto-layout fails on 9 of the OMG's own 22 reference models, 8 of them
silently — one loses 52 of 107 elements and reports no warning at all. therblig places
new elements next to their neighbours instead, and moves downstream shapes by one
uniform delta when it has to make room. Do not ask for a relayout as a way of tidying up.

## Read the outline before the whole thing

`bpmn_read` with `view: "outline"` gives pools, lanes and node names. That is usually
enough to decide what to change, and it is a fraction of the tokens. Ask for the full
projection when you need the flows.

`bpmn_explain` is better still when the question is "what does this process do" — it
returns counts, a complexity number and a Mermaid diagram.

## Two honest costs, worth saying out loud before you edit

**The first edit reformats the file.** therblig re-serializes the whole document, so a
file written by any tool other than a moddle-based one comes back reformatted once.
Every edit after that is minimal. Files from Camunda Modeler pay essentially nothing.

**That first write also drops XML comments**, along with DOCTYPE and processing
instructions — the parser does not model them. Roughly 4% of public `.bpmn` files carry
a comment inside the document body. Run `therblig fmt --check` first if the file might,
and tell the user before you write.

## Writing

`bpmn_patch` previews by default. To write, pass `dry_run: false` and the `base_rev` you
were given when you read the file — if it has changed on disk since, the write is refused
rather than overwriting whatever a modeller saved.

Before anything reaches the disk, the edit is compared against the original. If it
changed something the operations did not ask for, it is refused and the file is not
opened for writing at all. Read the diagnostics rather than retrying: each one names the
BPMN rule it enforces and the fix.

## When the linter disagrees with you

`bpmn_lint` separates two things. An **error** means the file is structurally broken or
violates the spec — a duplicate id, a dangling reference, a sequence flow crossing a
pool. A **warning** means the file is legal and probably wrong — an unlabelled gateway
branch, a pool with two start events. Warnings never block a write, and a file that
already had them keeps them; only what your edit introduces counts against it.
