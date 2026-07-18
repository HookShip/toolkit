# `@webhook-portal/compatibility-report`

Deterministic, human-readable compatibility reports for Webhook Portal canonical
contracts. Reports use only public `contract-core` and `canonical-model` APIs,
make no model or network calls, and never infer actual consumer usage.

## Install

```sh
npm install @webhook-portal/compatibility-report
```

## Example

```ts
import { diff } from "@webhook-portal/contract-core";
import {
  createCompatibilityReport,
  renderCompatibilityReportJson,
  renderCompatibilityReportMarkdown,
  verifyCompatibilityReport,
} from "@webhook-portal/compatibility-report";

const contractDiff = diff(previousContract, nextContract);
const report = createCompatibilityReport(previousContract, nextContract, {
  diff: contractDiff,
  view: "combined",
});

console.log(renderCompatibilityReportMarkdown(report));
console.log(renderCompatibilityReportJson(report));
console.log(verifyCompatibilityReport(report).valid);
```

Omit `diff` to compute it with the public `contract-core` helper. Producer and
consumer views affect Markdown sections but retain both machine-readable impact
records:

```ts
const producerReport = createCompatibilityReport(previous, next, {
  view: "producer",
});
```

## Safety and reproducibility

- Known diff codes have closed, fixed narratives. Unknown codes remain `unknown`
  and require review.
- Stable UTF-16 code-unit ordering makes JSON, checksums, and Markdown
  independent of locale and input key order.
- Dynamic values are bounded and escaped; contract descriptions and diff
  messages are not copied into narratives.
- Report checksums cover every field except the checksum itself.
- A `compatible` status means “proceed with verification,” not unconditional
  approval.

## Exports

- `@webhook-portal/compatibility-report`
- `@webhook-portal/compatibility-report/report`
- `@webhook-portal/compatibility-report/renderers`
- `@webhook-portal/compatibility-report/verification`

Apache-2.0.
