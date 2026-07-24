// SPDX-License-Identifier: Apache-2.0

import { canonicalize } from "@webhook-portal/contract-core";

import type { ReferenceServiceContext } from "./service-context.js";
import type { ImportContractInput } from "./service.js";
import type { ContractImportRecord } from "./types.js";

export class ContractService {
  readonly #ctx: ReferenceServiceContext;

  constructor(ctx: ReferenceServiceContext) {
    this.#ctx = ctx;
  }

  async importContract(
    input: ImportContractInput,
  ): Promise<ContractImportRecord> {
    const result = canonicalize(input.source, {
      formatHint:
        input.sourceMediaType === "application/json" ? "json" : "yaml",
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      limits: {
        maxInputBytes: this.#ctx.config.contractBodyLimitBytes,
      },
    });
    const record: ContractImportRecord = {
      id: this.#ctx.idFactory(),
      createdAt: this.#ctx.nowIso(),
      source: input.source,
      sourceMediaType: input.sourceMediaType,
      status: result.status,
      diagnostics: result.diagnostics,
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      ...(result.parsed.sourceChecksum === undefined
        ? {}
        : { sourceChecksum: result.parsed.sourceChecksum.value }),
      ...(result.contract === undefined ? {} : { contract: result.contract }),
      ...(result.export === undefined
        ? {}
        : { canonicalExport: result.export }),
    };
    await this.#ctx.repository.createContractImport(record);
    await this.#ctx.audit({
      action: "contract.import",
      resourceType: "contract_import",
      resourceId: record.id,
      result: result.status === "valid" ? "success" : "failure",
      correlationId: input.correlationId,
      details: {
        status: result.status,
        diagnosticCount: result.diagnostics.length,
      },
    });
    return record;
  }
}
