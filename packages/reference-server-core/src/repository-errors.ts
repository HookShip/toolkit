// SPDX-License-Identifier: Apache-2.0

export class RepositoryCommitUncertainError extends Error {
  readonly code = "REPOSITORY_COMMIT_UNCERTAIN";

  constructor(cause: unknown) {
    super("The transaction commit acknowledgement was not received.", {
      cause,
    });
    this.name = "RepositoryCommitUncertainError";
  }
}

export class PayloadCleanupConflictError extends Error {
  readonly code = "PAYLOAD_CLEANUP_IN_PROGRESS";
  readonly objectKey: string;
  readonly state: "deleted" | "deleting";

  constructor(objectKey: string, state: "deleted" | "deleting") {
    super(
      state === "deleted"
        ? "The payload object was deleted by reconciliation."
        : "The payload object is being deleted by reconciliation.",
    );
    this.name = "PayloadCleanupConflictError";
    this.objectKey = objectKey;
    this.state = state;
  }
}
