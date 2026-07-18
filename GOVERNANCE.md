# Governance

This project is currently maintained under a lightweight, maintainer-led model
appropriate for an early-stage open-source project. This document describes how
it works today and how that is expected to evolve.

## Decision-making

- Maintainers review and merge changes through pull requests. Non-trivial
  changes should be discussed in an issue before significant implementation
  work, so direction is agreed before effort is spent.
- Maintainers favor consensus. When maintainers disagree and discussion does not
  converge, the maintainer who has been most active in the affected area of the
  codebase makes the final call, and explains the reasoning in the relevant
  issue or pull request.
- Significant, hard-to-reverse decisions should be explained in the pull request
  that makes them (rationale and rejected alternatives), so future contributors
  understand _why_, not only _what_. As the project grows, this may move to
  dedicated architecture decision records.
- The [`ROADMAP.md`](ROADMAP.md) describes phase gates. A phase is not started
  until the previous phase's exit gate is demonstrably met — this is a technical
  and product gate, not a governance vote.

## Scope boundary enforced in this repository

This repository intentionally contains only the **open foundation** (see
[`README.md`](README.md#status-and-limitations) and [`ROADMAP.md`](ROADMAP.md)).
Contributions that add a managed multi-tenant control plane, hosted portal,
billing/metering, or other later-phase scope described in the roadmap are out of
scope for this repository until that phase formally begins, regardless of
otherwise-good code quality. This keeps the open/cloud boundary (enforced
technically by
[`scripts/check-package-boundaries.mjs`](scripts/check-package-boundaries.mjs))
honest at the process level too.

## Becoming a maintainer

There is no fixed contributor-to-maintainer ladder yet. In practice, sustained,
high-quality contributions (code, review, documentation, or triage) are how
someone becomes a maintainer; an existing maintainer proposes it and other
maintainers have the opportunity to object before it is final.

## Licensing and contributions

- All contributions to the packages listed in the README are accepted under the
  project's [Apache-2.0 license](LICENSE); by submitting a pull request you
  agree your contribution is licensed under the same terms.
- Contributors are encouraged to add a `Signed-off-by` line to commits
  (`git commit --signoff`) as a Developer Certificate of Origin-style
  attestation that they have the right to submit the contribution. This is
  currently a convention, not a CI-enforced requirement.

## Changes to this document

This document reflects current practice for a small, early-stage project and is
expected to change as the contributor and maintainer base grows — for example,
by introducing a formal maintainers list, a steering group, or a CLA, if and
when that becomes necessary. Proposed changes go through the normal pull request
process.
