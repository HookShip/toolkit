# Host and cloud target notes

This pack only returns configuration data. The host is responsible for
validating the exact target, resolving `roleReference`, selecting an AWS
endpoint, enforcing DNS/IP egress policy, performing the provider call, and
recording delivery evidence.

For EventBridge, prefer `events:PutEvents` restricted to the configured event
bus ARN: one exact event bus. For SQS, prefer `sqs:SendMessage` restricted to
the configured queue ARN: one exact queue. Add KMS permissions only when the
selected queue requires them, and scope them to the exact key and encryption
context. Do not grant account-wide `*` resources.

The host should reject region/account/target mismatches, private or unexpected
endpoints, unapproved cross-account roles, and target changes that have not
passed its own authorization workflow.
