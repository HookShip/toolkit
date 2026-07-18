// SPDX-License-Identifier: Apache-2.0

export class ExtensionSdkError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(
    code: string,
    message: string,
    options: { readonly cause?: unknown; readonly path?: string } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ExtensionSdkError";
    this.code = code;
    this.path = options.path;
  }
}

export class ExtensionValidationError extends ExtensionSdkError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path === undefined ? {} : { path });
    this.name = "ExtensionValidationError";
  }
}

export class BundleError extends ExtensionSdkError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path === undefined ? {} : { path });
    this.name = "BundleError";
  }
}

export class PermissionDeniedError extends ExtensionSdkError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path === undefined ? {} : { path });
    this.name = "PermissionDeniedError";
  }
}

export class DeclarativeRuntimeError extends ExtensionSdkError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path === undefined ? {} : { path });
    this.name = "DeclarativeRuntimeError";
  }
}

export class ResolutionError extends ExtensionSdkError {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message);
    this.name = "ResolutionError";
    this.details = details;
  }
}
