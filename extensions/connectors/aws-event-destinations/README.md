# AWS event destination configuration

This first-party source pack describes EventBridge/SQS-style destinations. It is
configuration and text only: there is no AWS SDK, credential material, DNS
resolution, request signing, or network execution.

## Resources

| Resource                    | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `configuration.schema`      | Closed host configuration for one exact AWS target      |
| `destination-plan.template` | Deterministic, non-executable configuration projection  |
| `host-cloud-notes.md`       | Host validation and least-privilege IAM review guidance |

`target` is intentionally generic because the closed schema DSL has no
conditional branches. The host must validate an EventBridge target as an exact
event bus and an SQS target as an exact queue, including region and account
agreement.

## Permission rationale

The manifest requests no permissions. Loading a schema or template does not
require outbound hosts, secret references, endpoint mutations, payload access,
or cloud credentials. The host may separately authorize a role reference and
provider call; that authority is outside this extension.

Recommended host-side IAM is `events:PutEvents` on one event bus or
`sqs:SendMessage` on one queue. Do not infer these host permissions from the
extension manifest.

## Compatibility

- Manifest: `1.0`
- Platform: `^0.1.0`
- Extension SDK: `^0.1.0`
- Runtime dependencies: none

## Fixtures and conformance

EventBridge and SQS fixtures render to checked expected plans. The
machine-readable declaration in `conformance.json` runs the common extension
suite plus tamper, reproducibility, leakage, and least-permission checks.

Development bundles are signed by an intentionally public test key. The
signature is never production trust; release tooling must rebuild and re-sign.
