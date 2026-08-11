# Organization context

This repository is one of five in the HookShip organization. Work belongs in the
repository that owns the affected behavior, and shared artifacts have a single
canonical source. These are organization-wide policies; this document links them
rather than restating them, so the organization copies stay authoritative.

- [Repository placement policy](https://github.com/HookShip/.github/blob/main/REPOSITORY_PLACEMENT.md)
  — where each kind of work belongs.
- [Source of truth](https://github.com/HookShip/.github/blob/main/SOURCE_OF_TRUTH.md)
  — which copy of a shared artifact is canonical.
- [Release policy](https://github.com/HookShip/.github/blob/main/RELEASE_POLICY.md)
  — the branch-protection and release baseline every repository builds on.

## Where toolkit fits

- **`toolkit` (this repository, public).** The public foundation: libraries, the
  CLI, adapters, webhook contracts, validation and compatibility logic,
  fixtures, types, and signing primitives. It is the source of truth for the
  public `@webhook-portal/*` packages, their interfaces, changelogs, and
  compatibility guarantees. See [`release-policy.md`](release-policy.md) and the
  [compatibility matrix](compatibility-matrix.md).
- **[`hook-service`](https://github.com/HookShip/hook-service) (public).** The
  portable outbound webhook delivery data plane: the delivery protocol, runtime,
  and single-cell durability surface. It consumes toolkit's published contract
  and signing primitives rather than restating them; where it references a
  contract or signing behavior, toolkit is the source of truth for that
  behavior.
- **`platform` (private).** The managed control plane and hosted-product
  engineering. It consumes the public foundation and never holds a competing
  public specification. Public documentation here never reproduces private
  platform material.
- **[`website`](https://github.com/HookShip/website) (public).** The public web
  presentation and navigation layer. It summarizes and links to toolkit
  documentation but never replaces this repository as the package source of
  truth.

## Consuming toolkit

`hook-service` and `platform` depend on the **published** toolkit packages; they
do not fork toolkit's contracts or re-publish its packages. Until a package is
published, its pre-release interface in this repository is still the source of
truth. Migrating a downstream consumer onto the published cohort is a separate,
dependent workstream.

Both public repositories are pre-release and have no public releases. This
document introduces no contacts, service levels, or endpoints beyond the
organization policies and repositories linked above. Report vulnerabilities
through the process in [`../SECURITY.md`](../SECURITY.md).
