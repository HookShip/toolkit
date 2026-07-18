// SPDX-License-Identifier: Apache-2.0

import { importContract } from "../dist/index.js";

const eventNames = ["zeta", "ävent", "İvent", "event", "Ωmega"];
const webhooks = Object.fromEntries(
  eventNames.map((name) => [
    name,
    {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                enum: ["β", "a", "ä"],
                type: "string",
              },
            },
          },
        },
        responses: { 200: { description: "Accepted" } },
        "x-event-type": name,
      },
    },
  ]),
);

const result = importContract({
  info: { title: "Locale", version: "1" },
  openapi: "3.1.0",
  webhooks,
});
if (result.contract === undefined) {
  process.stderr.write(JSON.stringify(result.diagnostics));
  process.exitCode = 1;
} else {
  process.stdout.write(
    JSON.stringify({
      checksum: result.contract.checksum.value,
      events: result.contract.eventTypes.map(
        ({ externalName }) => externalName,
      ),
    }),
  );
}
