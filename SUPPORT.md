# Support

This is an early-stage open-source project without a support SLA.

## Usage questions

Use this repository's GitHub Discussions area when it is enabled. Otherwise,
open an issue with the relevant package or app, the version or commit, the
command you ran, and a minimal reproducible example. Remove tokens, webhook
payloads, endpoint credentials, internal URLs, and other sensitive data first.

## Bugs

Use the bug-report issue form. Search existing issues before filing a new one,
and include the exact observed and expected behavior plus your Node.js version,
operating system, and whether Docker/Compose was involved.

## Feature requests

Use the feature-request issue form and explain the job to be done. Review
[`ROADMAP.md`](ROADMAP.md) and the README's current status first. Private
managed-pilot code is not an offer of hosted access or a support commitment.

## Managed pilot operational handoff

Operators of an approved managed pilot should use their deployment's private
incident/change channel, not a public issue. Follow the
[production pilot handoff](docs/operations/README.md#handoff-record) and the
[incident runbook](docs/operations/runbooks.md#incident-triage).

Include environment, image digest, migration versions, request IDs, normalized
error codes, aggregate health/metrics, backup/probe evidence, and the
case/change identifier. Do not include payloads, bodies, authorization headers,
cookies, tokens, secrets, credentials, internal URLs, object keys, ciphertext,
database URLs, or export download links.

## Security and conduct

- Suspected vulnerabilities: follow [`SECURITY.md`](SECURITY.md) and do not
  disclose details publicly.
- Community conduct concerns: follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Maintainers may prioritize reports based on reproducibility, impact, project
scope, and available capacity. Filing an issue does not create a response-time
or resolution commitment.

Future managed-offering support scope, escalation, and redacted communication
templates are maintained in
[`docs/launch/support-and-communications.md`](docs/launch/support-and-communications.md).
They are operational preparation and do not create an SLA.
