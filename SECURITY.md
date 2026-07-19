# Security Policy

## Supported versions

No package or application release has been published yet. Until the first
release, security fixes are made against the current default branch only. A
version support table will be added when releases exist; pre-1.0 versions should
not be assumed to receive indefinite backports.

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request containing vulnerability
details.

Use GitHub's **Report a vulnerability** flow for this repository when it is
available. Include:

- the affected package, application, command, or API route;
- the version or commit tested;
- reproduction steps or a minimal proof of concept;
- the security impact and any known preconditions; and
- whether the issue is already public or actively exploited.

If private vulnerability reporting is unavailable, use a private maintainer
contact published by the repository. If no private contact is published, open a
minimal public issue asking maintainers to establish a private channel **without
including any vulnerability details**.

Maintainers will investigate and coordinate remediation and disclosure through
the private report. No response-time or fix-time SLA is promised. Please avoid
accessing data that is not yours, disrupting services, or expanding testing
beyond what is needed to demonstrate the issue.

For normal bugs and usage questions, follow [`SUPPORT.md`](SUPPORT.md).

## Repository secret scanning

`pnpm check:secrets` runs both the current-tree high-confidence hygiene scanner
and Gitleaks across the complete Git history. The narrow allowlists in
`.gitleaks.toml` combine an exact file path, exact deterministic test value, and
the specific Gitleaks rule. They do not allow whole test directories, commits,
or generic secret formats.
