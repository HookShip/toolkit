# Examples

`orders.openapi.yaml` and `orders.asyncapi.yaml` describe the same small order
webhook family. `metadata/order-delivered.json` is a metadata-only delivery
observation.

Run the authenticated HTTPS demo:

```sh
./examples/demo.sh
```

The script generates credentials on first use, builds the production image,
waits for migration-aware readiness, then builds the host CLI together with its
workspace dependencies before publishing with an idempotency key. The Docker
image remains isolated from host build output. The demo creates an
endpoint/secret, sends one signed test, and ingests metadata. Publish uses the
checksum-derived stable key and verifies it through `publish-status`, so a
re-run recovers the original release. Type generation accepts the documented
partial exit intentionally. Metadata ingest explicitly uses the credential ID
generated into `infra/.env`; neither that ID nor its secret is printed.

The Compose app and preview remain running after the script exits:

```sh
curl --config infra/.curl-auth \
  --cacert infra/certs/ca.crt \
  https://127.0.0.1:3210/preview
```

Cleanup is deliberately separate:

```sh
./examples/demo-cleanup.sh
./examples/demo-cleanup.sh --volumes # also erase local data
```
