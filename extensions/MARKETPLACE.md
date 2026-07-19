# Public marketplace status: deferred

There is currently no public extension marketplace, production publisher trust
program, remote installation service, ranking, billing, or support entitlement.
The catalog in this repository is a source catalog for review and local
conformance only.

Before public marketplace work can begin, the project must separately define
publisher verification, controlled release signing, key rotation and revocation,
vulnerability response, lifecycle/deprecation rules, moderation, compatibility
guarantees, installation consent, and incident operations.

Development signatures committed here are intentionally public test assets. They
must not be accepted as production trust. Release tooling may reproduce a bundle
digest and then re-sign it with separately controlled keys; no existing
signature implies endorsement or marketplace approval.

Any future remote distribution design must preserve the provenance, permissions,
review, lifecycle, and revocation properties enforced by the SDK and conformance
suite. It is outside the current repository scope; see
[`ROADMAP.md`](../ROADMAP.md).
