# Architecture decision records

These records describe significant decisions implemented by the standalone
public toolkit.

## Conventions

- Files use `adr-NNNN-kebab-case-title.md`.
- Records contain `Status`, `Context`, `Decision`, and `Consequences`.
- Supported statuses are `Accepted`, `Superseded`, and `Deprecated`.
- Claims cite repository code, tests, configuration, or package documentation.
- Deployment-specific services and unavailable private components are outside
  the scope of these records.

## Index

| ADR                                                                               | Title                                                           | Status   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| [ADR-0001](adr-0001-open-core-workspace-boundary.md)                              | Standalone public toolkit workspace boundary                    | Accepted |
| [ADR-0002](adr-0002-metadata-only-payload-isolation.md)                           | Metadata-only payload isolation                                 | Accepted |
| [ADR-0005](adr-0005-contract-normalization-standards.md)                          | Contract normalization standards                                | Accepted |
| [ADR-0006](adr-0006-capability-based-adapter-interfaces.md)                       | Capability-based adapter interfaces                             | Accepted |
| [ADR-0007](adr-0007-declarative-signed-extensions-no-arbitrary-code-execution.md) | Declarative, signed extensions with no arbitrary code execution | Accepted |
| [ADR-0008](adr-0008-release-ownership-and-automation.md)                          | Release ownership and automation                                | Accepted |
| [ADR-0009](adr-0009-single-source-canonical-json.md)                              | Single-source canonical JSON serialization                      | Accepted |
| [ADR-0010](adr-0010-reference-server-core-package.md)                             | Reference server runtime as its own package                     | Accepted |

The numbering preserves the decisions inherited by this history-filtered public
extraction. Missing numbers refer to decisions that are not part of this
repository and are intentionally not referenced here.

## Lineage

ADRs form an auditable lineage, consistent with the organization
[source-of-truth policy](https://github.com/HookShip/.github/blob/main/SOURCE_OF_TRUTH.md):

- A decision that replaces an earlier one sets the earlier record's status to
  `Superseded` and links forward to its successor; the superseded record is kept
  and never edited to hide the change or deleted. The successor links back to
  what it supersedes.
- This repository owns the ADRs for public foundation decisions — packages,
  contracts, signing, adapters, extensions, and release automation. A protocol
  or data-plane decision is owned by
  [`hook-service`](https://github.com/HookShip/hook-service), and a private
  control-plane decision by `platform`.
- A decision that spans repositories records the primary ADR in the owning
  repository; companion records elsewhere link to it and do not restate its
  rationale. The primary ADR is the source of truth.
- Organization-wide governance decisions that are not specific to one product
  repository live in the `.github` repository, not here.
