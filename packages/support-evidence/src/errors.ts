// SPDX-License-Identifier: Apache-2.0

export class SupportEvidenceError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, message: string, path = "$") {
    super(message);
    this.name = "SupportEvidenceError";
    this.code = code;
    this.path = path;
  }

  toJSON(): {
    readonly name: string;
    readonly code: string;
    readonly path: string;
  } {
    return {
      name: this.name,
      code: this.code,
      path: this.path,
    };
  }
}

export class EvidenceValidationError extends SupportEvidenceError {
  constructor(code: string, message: string, path = "$") {
    super(code, message, path);
    this.name = "EvidenceValidationError";
  }
}

export class EvidenceSignatureError extends SupportEvidenceError {
  constructor(code: string, message: string, path = "$") {
    super(code, message, path);
    this.name = "EvidenceSignatureError";
  }
}
