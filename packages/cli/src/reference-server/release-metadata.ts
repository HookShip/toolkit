// SPDX-License-Identifier: Apache-2.0

import type { ReleaseMetadata, ReleaseRecord } from "./types.js";

const RELEASE_EVENT_PREVIEW_LIMIT = 20;
const RELEASE_EVENT_NAME_LIMIT = 256;

function boundedEventName(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const characters = [...value];
  if (characters.length <= RELEASE_EVENT_NAME_LIMIT) {
    return { value, truncated: false };
  }
  return {
    value: `${characters.slice(0, RELEASE_EVENT_NAME_LIMIT - 1).join("")}…`,
    truncated: true,
  };
}

export function releaseMetadata(release: ReleaseRecord): ReleaseMetadata {
  const eventTypes = release.contract.eventTypes;
  return {
    id: release.id,
    importId: release.importId,
    sequence: release.sequence,
    checksum: release.checksum,
    status: release.active ? "active" : "superseded",
    createdAt: release.createdAt,
    compatibilityStatus: release.changelog.status,
    changeCount: release.changelog.changes.length,
    eventSummary: {
      eventTypeCount: eventTypes.length,
      eventVersionCount: eventTypes.reduce(
        (total, eventType) => total + eventType.versions.length,
        0,
      ),
      preview: eventTypes
        .slice(0, RELEASE_EVENT_PREVIEW_LIMIT)
        .map((eventType) => {
          const externalName = boundedEventName(eventType.externalName);
          return {
            id: eventType.id,
            externalName: externalName.value,
            externalNameTruncated: externalName.truncated,
            versionCount: eventType.versions.length,
          };
        }),
      truncated: eventTypes.length > RELEASE_EVENT_PREVIEW_LIMIT,
    },
  };
}
