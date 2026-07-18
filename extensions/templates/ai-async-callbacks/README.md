# AI asynchronous callback templates

This vertical pack supplies an illustrative metadata contract, example callback,
portal content, and endpoint/subscription configuration templates for
asynchronous AI job events.

It does not define model behavior, completion guarantees, availability,
durability, billing semantics, or a system of record. Producers must adapt the
contract to their actual product and consumers must verify state through an
authenticated producer API before consequential action.

## Resources

| Resource                       | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `callback-contract.schema`     | Closed metadata-only illustrative callback schema |
| `callback-example.data`        | Synthetic callback example without model content  |
| `portal-content.md`            | Consumer-facing safety and integration copy       |
| `endpoint-config.template`     | Endpoint configuration using a secret reference   |
| `subscription-config.template` | Event subscription configuration                  |

## Permission rationale

The manifest requests no permissions. Loading text, schema, and example data
does not require payload, secret, network, endpoint, or subscription authority.
`signingSecretReference` is an opaque host configuration identifier, never
secret material and never resolved by this pack.

## Compatibility

- Manifest: `1.0`
- Platform: `^0.1.0`
- Extension SDK: `^0.1.0`
- Runtime dependencies: none

## Fixtures and conformance

Fixtures render endpoint and subscription templates to deterministic expected
text. Tests also validate the closed schema, inspect the synthetic example,
reject tampering, and ensure the portal content avoids domain promises and raw
payload guidance.

Development signatures use an intentionally public test key and are not
production trust.
