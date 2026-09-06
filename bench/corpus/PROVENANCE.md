# Corpus provenance

Every fixture here has a verified, first-party license that permits redistribution in an
Apache-2.0 repository. Anything that does not is listed at the bottom and excluded.

## Included

### `miwg/` — 21 files, 1.3 MB
BPMN Model Interchange Working Group reference models.
Source: https://github.com/bpmn-miwg/bpmn-miwg-test-suite `Reference/*.bpmn`
Pinned commit: `cb2629519cee6280ab521f99dc46a9815a221a35` (2026-03-11)
License: **Creative Commons Attribution 3.0 Unported (CC BY 3.0)**
Attribution carried in the root `NOTICE` file, satisfying CC BY 3.0 section 4(c).

Only `Reference/` is vendored. The full repository is 286 MB because it stores 40+
vendors' import/export results; none of that is needed.

Coverage: 9 different exporters, 9 files carrying vendor extensions (camunda, zeebe,
signavio), 4 with pools and lanes, boundary events, subprocesses, event subprocesses,
data stores, groups. Strata by flow-node count: 9 small (<15), 12 medium (15-50), 1 large.

### `handmade/` — files authored for this repo
Original work, Apache-2.0 with the rest of the repository.

| file | why it exists |
|---|---|
| `zeebe-roundtrip.bpmn` | Camunda 8 / Zeebe extension elements, to prove a round-trip loses none of them (F1). |
| `parallel-join.bpmn` | A parallel split whose branches take 4h and 9h, annotated with `treadle:duration`. The corpus has no file that states how long anything takes, so it is the only fixture that can show a join takes the longer branch and not the sum (F17). |

## Excluded, with reasons

| asset | why |
|---|---|
| **SAP-SAM** (618,807 BPMN models) | Non-commercial, no-derivatives, and grants rights only to natural persons. Three independent blockers. Not shippable, not fetchable at test time, not usable in CI. |
| **OMG "BPMN 2.0 by Example"** | The document forbids posting on a network computer and forbids modification. May be cited by URL only. |
| **`camunda/bpmn-for-research`** | "Academic and research purposes only". This restriction propagates to anything derived from it, including PMo pairs 21-24 and the Deka & Devereux BPMN-VLM set. |
| **MaD dataset** | Not publicly obtainable, no discoverable license, and its ground truth is DOT rather than BPMN 2.0 XML. |
| **`chlauer/Signavio_text_bpmn`** | No license, Signavio-derived provenance, and its output format is BPIL rather than BPMN XML. |

## Wanted

The corpus is thin at the top end: only one file above 50 flow nodes, and the plan calls
for five. Candidate permissively-licensed sources not yet mined: Operaton, Flowable and
Camunda 7 platform test resources (all Apache-2.0), and the PMo dataset (CC BY 4.0,
excluding pairs 21-24).
