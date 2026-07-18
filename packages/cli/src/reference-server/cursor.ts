// SPDX-License-Identifier: Apache-2.0

import type { TimelineEntry } from "./types.js";
import { metadataTimelineIdentityKey } from "./crypto.js";

export const MAX_TIMELINE_CURSOR_LENGTH = 512;

export interface TimelineCursorPosition {
  readonly lastIngestedAt: string;
  readonly identityKey: string;
}

export class InvalidTimelineCursorError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("The timeline cursor is invalid.");
    this.name = "InvalidTimelineCursorError";
  }
}

function invalidCursor(): never {
  throw new InvalidTimelineCursorError();
}

export function encodeTimelineCursor(entry: TimelineEntry): string {
  return Buffer.from(
    `${entry.lastIngestedAt}\n${metadataTimelineIdentityKey(entry.current)}`,
    "utf8",
  ).toString("base64url");
}

export function decodeTimelineCursor(cursor: string): TimelineCursorPosition {
  if (
    cursor.length === 0 ||
    cursor.length > MAX_TIMELINE_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    return invalidCursor();
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_TIMELINE_CURSOR_LENGTH ||
    bytes.toString("base64url") !== cursor
  ) {
    return invalidCursor();
  }
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    return invalidCursor();
  }
  const separator = decoded.indexOf("\n");
  if (
    separator <= 0 ||
    separator !== decoded.lastIndexOf("\n") ||
    separator === decoded.length - 1
  ) {
    return invalidCursor();
  }
  const lastIngestedAt = decoded.slice(0, separator);
  const identityKey = decoded.slice(separator + 1);
  const parsedTimestamp = Date.parse(lastIngestedAt);
  if (
    !Number.isFinite(parsedTimestamp) ||
    new Date(parsedTimestamp).toISOString() !== lastIngestedAt ||
    !/^whp:timeline:v1:[0-9a-f]{64}$/u.test(identityKey)
  ) {
    return invalidCursor();
  }
  return { lastIngestedAt, identityKey };
}

export function timelineEntryIsAfterCursor(
  entry: TimelineEntry,
  cursor: TimelineCursorPosition,
): boolean {
  const time = entry.lastIngestedAt.localeCompare(cursor.lastIngestedAt);
  return (
    time < 0 ||
    (time === 0 &&
      metadataTimelineIdentityKey(entry.current).localeCompare(
        cursor.identityKey,
      ) < 0)
  );
}
