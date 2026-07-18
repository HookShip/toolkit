# AI asynchronous job callbacks

These events are illustrative notifications that a producer's recorded job state
changed. They are not a promise of model quality, completion time, availability,
result durability, or business outcome.

Verify the webhook signature and event ID before processing. Treat status and
progress as informational, make handlers idempotent, and query the producer's
authenticated system of record before taking consequential action.

The callback contains metadata only. If `resultReference` is present, authorize
that separate request and apply the producer's retention rules. Do not put model
inputs, outputs, prompts, credentials, or personal data into portal examples.
