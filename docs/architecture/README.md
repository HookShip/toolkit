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

The numbering preserves the decisions inherited by this history-filtered public
extraction. Missing numbers refer to decisions that are not part of this
repository and are intentionally not referenced here.
