// SPDX-License-Identifier: Apache-2.0

import { importContract } from "../dist/index.js";

const pattern = "^(a|aa)+$";
const result = importContract({
  info: { title: "Regex", version: "1" },
  openapi: "3.1.0",
  webhooks: {
    event: {
      post: {
        requestBody: {
          content: {
            "application/json": {
              example: `${"a".repeat(30_000)}!`,
              schema: { pattern, type: "string" },
            },
          },
        },
        responses: { 200: { description: "Accepted" } },
        "x-event-type": "event",
      },
    },
  },
});

process.stdout.write(
  JSON.stringify({
    diagnostic: result.diagnostics.some(
      ({ code }) => code === "REGEX_CONSTRAINTS_NOT_EVALUATED",
    ),
    pattern: result.contract?.eventTypes[0]?.versions[0]?.schema.value.pattern,
    status: result.status,
  }),
);
