# `@webhook-portal/signing`

Strict Standard Webhooks signing and verification using Node's HMAC-SHA256
implementation.

Secrets supplied at a trust boundary must use `whsec_` followed by canonical
standard Base64, including required `=` padding. Decoded keys must be 24–64
bytes:

```ts
const secret = WebhookSecret.fromEncoded(process.env.WEBHOOK_SECRET!);
```

`WebhookSecret.fromBytes()` is intentionally available for controlled KMS/HSM
adapters and deterministic tests. It copies the supplied bytes and enforces the
same 24–64-byte range. Secret objects and parsed signatures redact their values
from string and JSON output.

`signWebhook()` and `verifyWebhook()` are the interoperability APIs. Strings are
encoded as UTF-8; byte inputs must contain valid UTF-8 and are signed without
JSON parsing or reserialization. This preserves valid raw HTTP request bodies
while matching Standard Webhooks string semantics. Invalid UTF-8 bytes raise
`InvalidPayloadError`.

`signWebhookRawBytes()` and `verifyWebhookRawBytes()` are explicitly local,
byte-exact extensions for arbitrary binary payloads. Their output is
self-consistent within this package, but invalid UTF-8 payloads are outside
cross-language Standard Webhooks guarantees.

Signing emits `webhook-id`, `webhook-timestamp`, and `webhook-signature`
headers. Verification accepts multiple `v1` signatures and active/overlapping
secrets, supports an injected clock, and defaults to a 300-second timestamp
tolerance.

Message IDs containing `.` are rejected because dots delimit the signed
`{id}.{timestamp}.{body}` tuple. Signatures use standard padded Base64.

## Migration

Secrets previously serialized with the URL-safe alphabet (`-` or `_`) or with
omitted required padding are rejected. Re-encode the original 24–64 raw key
bytes using standard Base64; do not generate a different key unless performing a
deliberate secret rotation.
