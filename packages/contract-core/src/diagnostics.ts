// SPDX-License-Identifier: Apache-2.0

import type {
  ContractDiagnostic,
  DiagnosticSeverity,
  JsonObject,
  SourceRange,
} from "@webhook-portal/canonical-model";

export interface AddDiagnostic {
  readonly code: string;
  readonly details?: JsonObject | undefined;
  readonly message: string;
  readonly pointer?: string | undefined;
  readonly severity: DiagnosticSeverity;
  readonly source?: SourceRange | undefined;
}

function severityRank(severity: DiagnosticSeverity): number {
  switch (severity) {
    case "fatal":
      return 3;
    case "error":
      return 2;
    case "warning":
      return 1;
    case "info":
      return 0;
  }
}

export class DiagnosticCollector {
  readonly #diagnostics: ContractDiagnostic[] = [];
  readonly #maximum: number;
  #omittedHighestSeverity: DiagnosticSeverity = "info";
  #omitted = 0;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  add(diagnostic: AddDiagnostic): void {
    if (this.#diagnostics.length < this.#maximum) {
      this.#diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        severity: diagnostic.severity,
        ...(diagnostic.details === undefined
          ? {}
          : { details: diagnostic.details }),
        ...(diagnostic.pointer === undefined
          ? {}
          : { pointer: diagnostic.pointer }),
        ...(diagnostic.source === undefined
          ? {}
          : { source: diagnostic.source }),
      });
      return;
    }

    this.#omitted += 1;
    if (
      severityRank(diagnostic.severity) >
      severityRank(this.#omittedHighestSeverity)
    ) {
      this.#omittedHighestSeverity = diagnostic.severity;
    }
  }

  addAll(diagnostics: readonly ContractDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.add(diagnostic);
    }
  }

  hasErrors(): boolean {
    return this.#diagnostics.some(
      ({ severity }) => severity === "error" || severity === "fatal",
    );
  }

  hasFatal(): boolean {
    return this.#diagnostics.some(({ severity }) => severity === "fatal");
  }

  toArray(): readonly ContractDiagnostic[] {
    if (this.#omitted === 0 || this.#maximum === 0) {
      return [...this.#diagnostics];
    }

    if (this.#maximum === 1) {
      const only = this.#diagnostics[0];
      if (
        only !== undefined &&
        severityRank(only.severity) >=
          severityRank(this.#omittedHighestSeverity)
      ) {
        return [only];
      }
      return [
        {
          code: "DIAGNOSTICS_TRUNCATED",
          details: { omitted: this.#omitted + 1 },
          message: `${this.#omitted + 1} diagnostic(s) were omitted`,
          severity: this.#omittedHighestSeverity,
        },
      ];
    }

    const replaced = this.#diagnostics.at(-1);
    const severity =
      replaced !== undefined &&
      severityRank(replaced.severity) >
        severityRank(this.#omittedHighestSeverity)
        ? replaced.severity
        : this.#omittedHighestSeverity;
    const truncated: ContractDiagnostic = {
      code: "DIAGNOSTICS_TRUNCATED",
      details: { omitted: this.#omitted + 1 },
      message: `${this.#omitted + 1} additional diagnostic(s) were omitted`,
      severity,
    };

    if (this.#diagnostics.length < this.#maximum) {
      return [...this.#diagnostics, truncated];
    }

    return [...this.#diagnostics.slice(0, -1), truncated];
  }
}
