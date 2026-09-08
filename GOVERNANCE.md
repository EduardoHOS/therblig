# Governance

## Licence promise

**therblig's core will not be relicensed.** Everything published under this repository
is Apache-2.0 and stays Apache-2.0. We will not move it to a source-available licence,
a business-source licence, or any other non-OSI licence.

We take contributions under the [DCO](https://developercertificate.org/) rather than a
CLA specifically so that we *cannot* quietly do that later: without a copyright
assignment or a broad relicensing grant from every contributor, the core is not ours to
relicense unilaterally. The absence of a CLA is the guarantee, not the promise.

This matters in this particular market. Camunda 8 Self-Managed moved to the non-OSI
Camunda Licence 1.0 in October 2024 and Camunda 7 CE reached end of life. People
building on BPMN tooling have been burned by exactly this, and are right to ask.

## Commercial model

therblig is maintainer-led and there is no company behind it today. There may be one
later — the intent is to eventually fund the work commercially — and that is stated
plainly rather than discovered later, because the licence promise above only means
something if you know what pressures it is meant to survive.

If that happens, the boundary is **which repository code lives in, never a licence
restriction on the core**:

- Everything in this repository — the MCP server, the CLI, the library, the linter,
  the benchmark — is Apache-2.0, and is the complete, unrestricted product for local and
  self-hosted use. No feature is withheld, time-limited, or gated behind a key.
- Commercial offerings are things that are genuinely multi-tenant systems problems and
  cannot ship as a local file tool: hosted collaboration, a shared process repository,
  org-wide lint policy enforcement, SSO and audit, a managed remote MCP endpoint.

The test we hold ourselves to: **no commercial offering may create pressure to make the
open core worse.** If a proposed feature only makes commercial sense because the free
version is deliberately limited, it does not ship.

## Decision-making

Today: maintainer-led, with decisions recorded as ADRs in
[docs/DECISIONS.md](docs/DECISIONS.md) rather than settled in private. Each ADR states
what it rests on and what would reverse it, so disagreement can be about evidence
instead of authority.

As the project grows we will move to a documented committer model. Contributors who
land substantive work will be invited to commit rights before that is formalised, not
after.

## Trademark

The therblig name is held by the maintainers and is not covered by the Apache-2.0 grant,
which covers copyright and patents but not trademarks. No trademark registration has
been filed yet. You may say your software works with therblig, is built on therblig, or is
a fork of therblig. Please do not use the name in a way that implies the project endorses
or maintains your distribution.

**A caveat recorded honestly, because the open-core boundary leans on this name.**
"Therblig" is not a coined word. It is an established term of art in industrial
engineering — a unit of elemental motion, named by Frank and Lillian Gilbreth (roughly
their surname reversed) and in continuous technical use since the 1910s. That cuts both
ways. It is unlikely to collide with an existing mark, and it is thematically exact for a
tool about process. But descriptive and established technical terms are weak marks: they
are harder to register, narrower in the protection they earn, and in a field where the
term is genuinely used, arguably generic. Since GOVERNANCE says the commercial boundary is
repo-level rather than licence-level, the name is the main enforcement mechanism the
project has — so this is a real trade, not a footnote. Verified 2026-09-04: `therblig`,
`therblig-mcp` and `therbligs` are free on npm and PyPI; the GitHub account `therblig` is
taken by a dormant user (created 2020, zero public repos), so the MCP registry namespace
is `io.github.eduardohos/therblig` rather than an org namespace. Clearance and
registrability need a lawyer before any registration is attempted.

BPMN and the BPMN logo are trademarks of the Object Management Group. Camunda, Signavio
and ARIS are trademarks of their respective owners. therblig is not affiliated with,
endorsed by, or sponsored by any of them.
