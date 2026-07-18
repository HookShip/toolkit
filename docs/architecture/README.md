# Architecture decision records

This directory records the significant architectural decisions implemented in
this repository, in the lightweight ADR (Architecture Decision Record) style.
Each record is standalone: it can be read, understood, and evaluated without
reading the others, even though later records often build on earlier ones.

Start with the [repository architecture overview](overview.md) for the system
map, layer and plane boundaries, dependency direction, data flows, security
invariants, and deployment topologies. Use the ADRs below for the reasons and
tradeoffs behind those structures.

## Conventions

- **Numbering:** sequential, four digits, never reused (`ADR-0001`, `ADR-0002`,
  ...).
- **File naming:** `adr-NNNN-kebab-case-title.md`, matching the numeric prefix
  in the document's `ADR-NNNN` title.
- **Required sections:** `Title`, `Status`, `Context`, `Decision`,
  `Consequences`, in that order.
- **Status values:** `Accepted`, `Superseded`, or `Deprecated`. A `Superseded`
  or `Deprecated` record links to the record that replaces it.
- **Scope discipline:** a record describes what is actually implemented in this
  repository. Where a decision has an implemented part and a not-yet-implemented
  or externally-gated part (for example, a private managed engineering pilot
  versus an operated hosted service with real providers and customers), the
  record says so explicitly rather than implying the whole scope is live. See
  [`ROADMAP.md`](../../ROADMAP.md) and
  [`docs/launch/README.md`](../launch/README.md) for the current phase and
  external-gate status.
- **Evidence:** records cite concrete repository paths (source, config, package
  `README.md` files, migrations) rather than external links, customer claims, or
  unverifiable figures.

## Index

| ADR                                                                               | Title                                                           | Status   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| [ADR-0001](adr-0001-open-core-workspace-boundary.md)                              | Open-core workspace boundary                                    | Accepted |
| [ADR-0002](adr-0002-metadata-only-payload-isolation.md)                           | Metadata-only payload isolation                                 | Accepted |
| [ADR-0003](adr-0003-modular-monolith-control-plane-with-dedicated-worker.md)      | Modular-monolith control plane with a dedicated worker          | Accepted |
| [ADR-0004](adr-0004-postgresql-durable-jobs-and-forced-row-level-security.md)     | PostgreSQL durable jobs and forced row-level security           | Accepted |
| [ADR-0005](adr-0005-contract-normalization-standards.md)                          | Contract normalization standards                                | Accepted |
| [ADR-0006](adr-0006-capability-based-adapter-interfaces.md)                       | Capability-based adapter interfaces                             | Accepted |
| [ADR-0007](adr-0007-declarative-signed-extensions-no-arbitrary-code-execution.md) | Declarative, signed extensions with no arbitrary code execution | Accepted |
| [ADR-0008](adr-0008-provider-neutral-billing-boundary.md)                         | Provider-neutral billing boundary                               | Accepted |
| [ADR-0009](adr-0009-managed-role-separation.md)                                   | Managed role separation                                         | Accepted |

## Reading order

New contributors get the most coherent picture reading in numeric order:
ADR-0001 establishes what is Apache-2.0 and self-hostable versus what is private
managed infrastructure; ADR-0002 through ADR-0006 describe the open foundation's
data and integration model; ADR-0007 through ADR-0009 describe how the private
managed control plane extends that foundation without changing its guarantees.
