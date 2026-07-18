// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  analyzePolicyPermissions,
  analyzeTransformPermissions,
  canonicalJson,
  comparePermissionSets,
  loadConnectorPack,
  loadPolicyProgram,
  loadTemplatePack,
  loadTransformProgram,
  normalizePermissionSet,
  runPolicy,
  runTransform,
  serializeExtensionBundle,
  validateConfigurationSchema,
  verifyExtensionBundle,
} from "../../packages/extension-sdk/dist/index.js";
import {
  assertExtensionConformance,
  runExtensionConformance,
} from "../../packages/extension-conformance/dist/index.js";

import { PACK_SPECS, buildPack } from "../scripts/build-sign.mjs";

const extensionsRoot = fileURLToPath(new URL("..", import.meta.url));
const leakageSentinels = Object.freeze([
  "fixture-secret-never-emit",
  "Bearer fixture-secret-never-emit",
  "private@example.test",
  "-----BEGIN PRIVATE KEY-----",
]);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function asset(bundle, assetPath) {
  const found = bundle.assets.find((candidate) => candidate.path === assetPath);
  assert.ok(found, `Missing bundle asset ${assetPath}.`);
  return found;
}

function renderTemplate(template, variables) {
  const rendered = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu,
    (_, name) => {
      assert.ok(Object.hasOwn(variables, name), `Missing variable ${name}.`);
      const value = variables[name];
      assert.ok(
        value === null ||
          typeof value === "boolean" ||
          typeof value === "number" ||
          typeof value === "string",
        `Template variable ${name} must be scalar.`,
      );
      return value === null ? "" : String(value);
    },
  );
  assert.doesNotMatch(rendered, /\{\{/u);
  return rendered;
}

function validateSchemaValue(schema, value, valuePath = "$") {
  if (Array.isArray(schema.enum)) {
    assert.ok(
      schema.enum.some(
        (candidate) => canonicalJson(candidate) === canonicalJson(value),
      ),
      `${valuePath} is not in the declared enum.`,
    );
  }
  if (Object.hasOwn(schema, "const")) {
    assert.equal(canonicalJson(value), canonicalJson(schema.const));
  }

  switch (schema.type) {
    case "object": {
      assert.ok(
        value !== null && typeof value === "object" && !Array.isArray(value),
        `${valuePath} must be an object.`,
      );
      const properties = schema.properties ?? {};
      for (const required of schema.required ?? []) {
        assert.ok(
          Object.hasOwn(value, required),
          `${valuePath}.${required} is required.`,
        );
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          assert.ok(
            Object.hasOwn(properties, key),
            `${valuePath}.${key} is not declared.`,
          );
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          validateSchemaValue(properties[key], child, `${valuePath}.${key}`);
        }
      }
      break;
    }
    case "array":
      assert.ok(Array.isArray(value), `${valuePath} must be an array.`);
      for (let index = 0; index < value.length; index += 1) {
        validateSchemaValue(
          schema.items,
          value[index],
          `${valuePath}[${index}]`,
        );
      }
      break;
    case "string":
      assert.equal(typeof value, "string", `${valuePath} must be a string.`);
      if (schema.minLength !== undefined) {
        assert.ok(value.length >= schema.minLength);
      }
      if (schema.maxLength !== undefined) {
        assert.ok(value.length <= schema.maxLength);
      }
      if (schema.format === "uri") {
        assert.doesNotThrow(() => new URL(value));
      }
      if (schema.format === "date-time") {
        assert.equal(new Date(value).toISOString(), value);
      }
      break;
    case "number":
    case "integer":
      assert.equal(typeof value, "number", `${valuePath} must be numeric.`);
      assert.ok(Number.isFinite(value));
      if (schema.type === "integer") {
        assert.ok(Number.isInteger(value));
      }
      if (schema.minimum !== undefined) {
        assert.ok(value >= schema.minimum);
      }
      if (schema.maximum !== undefined) {
        assert.ok(value <= schema.maximum);
      }
      break;
    case "boolean":
      assert.equal(typeof value, "boolean");
      break;
    case "null":
      assert.equal(value, null);
      break;
  }
}

async function declaredConformanceFixture(spec, built, declaration) {
  const firstFixture = declaration.fixtures[0];
  const fixture = {
    name: `${spec.id} source pack`,
    bundle: built.bundle,
    expectedKind: declaration.expectedKind,
    platformVersion: declaration.platformVersion,
    sdkVersion: declaration.sdkVersion,
    trustPolicy: built.trustPolicy,
    rebuild: async () => (await buildPack(spec)).bundle,
  };
  if (spec.kind === "transform") {
    fixture.transformInput = await readJson(
      path.join(built.packDirectory, firstFixture.input),
    );
  }
  if (spec.kind === "policy") {
    fixture.policyInput = await readJson(
      path.join(built.packDirectory, firstFixture.input),
    );
  }
  return fixture;
}

for (const spec of PACK_SPECS) {
  describe(spec.id, () => {
    test("contains complete source-pack declarations", async () => {
      const packDirectory = path.join(extensionsRoot, spec.relativeDirectory);
      for (const fileName of [
        "manifest.source.json",
        "README.md",
        "CHANGELOG.md",
        "PROVENANCE.md",
        "conformance.json",
      ]) {
        await access(path.join(packDirectory, fileName));
      }
      const declaration = await readJson(
        path.join(packDirectory, "conformance.json"),
      );
      assert.equal(declaration.suite, "@webhook-portal/extension-conformance");
      assert.equal(declaration.suiteVersion, "0.1.0");
      assert.equal(declaration.expectedKind, spec.kind);
      assert.ok(declaration.customChecks.length >= 5);
      for (const fixture of declaration.fixtures) {
        await access(path.join(packDirectory, fixture.input));
        await access(path.join(packDirectory, fixture.expectedOutput));
      }
    });

    test("passes extension conformance", async () => {
      const built = await buildPack(spec);
      const declaration = await readJson(
        path.join(built.packDirectory, "conformance.json"),
      );
      const fixture = await declaredConformanceFixture(
        spec,
        built,
        declaration,
      );
      const report = await runExtensionConformance(fixture);
      assert.deepEqual(
        report.results.map((result) => result.id),
        declaration.requiredCaseIds,
      );
      assertExtensionConformance(report);
    });

    test("is reproducible and rejects asset or signature tampering", async () => {
      const first = await buildPack(spec);
      const second = await buildPack(spec);
      assert.equal(first.serialized, second.serialized);
      assert.equal(
        first.bundle.manifest.integrity.contentDigest,
        second.bundle.manifest.integrity.contentDigest,
      );
      assert.equal(
        first.bundle.manifest.integrity.bundleDigest,
        second.bundle.manifest.integrity.bundleDigest,
      );

      const tamperedAsset = {
        ...first.bundle,
        assets: first.bundle.assets.map((candidate, index) =>
          index === 0
            ? { ...candidate, content: `${candidate.content}\nTAMPERED` }
            : candidate,
        ),
      };
      assert.equal(
        verifyExtensionBundle(tamperedAsset, {
          trustPolicy: first.trustPolicy,
        }).ok,
        false,
      );

      const [signature] = first.bundle.manifest.integrity.signatures;
      assert.ok(signature);
      const replacement = signature.signature.startsWith("A") ? "B" : "A";
      const tamperedSignature = {
        ...first.bundle,
        manifest: {
          ...first.bundle.manifest,
          integrity: {
            ...first.bundle.manifest.integrity,
            signatures: [
              {
                ...signature,
                signature: `${replacement}${signature.signature.slice(1)}`,
              },
            ],
          },
        },
      };
      assert.equal(
        verifyExtensionBundle(tamperedSignature, {
          trustPolicy: first.trustPolicy,
        }).ok,
        false,
      );
    });

    test("uses minimal permissions and contains no secret fixture material", async () => {
      const built = await buildPack(spec);
      const permissions = built.bundle.manifest.permissions;
      assert.deepEqual(permissions.outboundHosts, []);
      assert.deepEqual(permissions.secretReferences, []);
      assert.deepEqual(permissions.endpointActions, []);
      assert.deepEqual(permissions.subscriptionActions, []);

      if (spec.kind === "transform") {
        const program = loadTransformProgram(built.verification);
        const required = analyzeTransformPermissions(program);
        assert.equal(
          comparePermissionSets(required, permissions).allowed,
          true,
        );
        assert.deepEqual(permissions.payloadRead, required.payloadRead);
        assert.deepEqual(permissions.payloadWrite, ["*"]);
        assert.ok(
          permissions.payloadRead.every(
            (candidate) =>
              candidate !== "/payload" && !candidate.startsWith("/payload/"),
          ),
        );
      } else if (spec.kind === "policy") {
        const program = loadPolicyProgram(built.verification);
        assert.deepEqual(permissions, analyzePolicyPermissions(program));
        assert.deepEqual(permissions.payloadRead, []);
        assert.deepEqual(permissions.payloadWrite, []);
      } else {
        assert.deepEqual(permissions, normalizePermissionSet({}));
      }

      const serialized = serializeExtensionBundle(built.bundle);
      for (const sentinel of leakageSentinels) {
        assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
      }
    });

    test("matches declared fixture output and pack-specific safety checks", async () => {
      const built = await buildPack(spec);
      const declaration = await readJson(
        path.join(built.packDirectory, "conformance.json"),
      );

      if (spec.kind === "connector") {
        const pack = loadConnectorPack(built.verification);
        for (const fixture of declaration.fixtures) {
          const input = await readJson(
            path.join(built.packDirectory, fixture.input),
          );
          validateSchemaValue(pack.configurationSchema, input);
          const expected = await readFile(
            path.join(built.packDirectory, fixture.expectedOutput),
            "utf8",
          );
          assert.equal(
            renderTemplate(pack.templates[fixture.template], input),
            expected,
          );
        }
        const notes = pack.templates["host-cloud-notes.md"];
        assert.match(notes, /events:PutEvents/u);
        assert.match(notes, /sqs:SendMessage/u);
        assert.match(notes, /exact (event bus|queue)/u);
      }

      if (spec.kind === "transform") {
        const fixture = declaration.fixtures[0];
        const input = await readJson(
          path.join(built.packDirectory, fixture.input),
        );
        const expected = await readJson(
          path.join(built.packDirectory, fixture.expectedOutput),
        );
        const output = runTransform(
          loadTransformProgram(built.verification),
          input,
          { permissions: built.bundle.manifest.permissions },
        );
        assert.equal(canonicalJson(output), canonicalJson(expected));
        assert.equal(output.extensions.cloudEventId, input.cloudEvent.id);
        assert.equal(
          output.extensions.standardWebhookId,
          input.standardWebhook.id,
        );
        assert.equal(
          output.extensions.webhookVersion,
          input.standardWebhook.version,
        );
        for (const sentinel of leakageSentinels) {
          assert.doesNotMatch(canonicalJson(output), new RegExp(sentinel, "u"));
        }
        assert.equal(Object.hasOwn(output, "payload"), false);
      }

      if (spec.kind === "policy") {
        const fixture = declaration.fixtures[0];
        const input = await readJson(
          path.join(built.packDirectory, fixture.input),
        );
        const expected = await readJson(
          path.join(built.packDirectory, fixture.expectedOutput),
        );
        const output = runPolicy(loadPolicyProgram(built.verification), input, {
          permissions: built.bundle.manifest.permissions,
        });
        assert.equal(canonicalJson(output), canonicalJson(expected));
        for (const sentinel of leakageSentinels) {
          assert.doesNotMatch(canonicalJson(output), new RegExp(sentinel, "u"));
        }
        assert.equal(Object.hasOwn(output, "payload"), false);

        const retention = JSON.parse(
          asset(built.bundle, "retention-recommendations.data").content,
        );
        assert.equal(retention.authority, false);
        assert.ok(
          retention.recommendations.every(
            (recommendation) =>
              recommendation.findingCode === "field_classified",
          ),
        );
      }

      if (spec.kind === "template") {
        const pack = loadTemplatePack(built.verification);
        for (const fixture of declaration.fixtures) {
          const input = await readJson(
            path.join(built.packDirectory, fixture.input),
          );
          const expected = await readFile(
            path.join(built.packDirectory, fixture.expectedOutput),
            "utf8",
          );
          assert.equal(
            renderTemplate(pack.templates[fixture.template].content, input),
            expected,
          );
        }

        const schema = validateConfigurationSchema(
          JSON.parse(asset(built.bundle, "callback-contract.schema").content),
        );
        const example = JSON.parse(
          asset(built.bundle, "callback-example.data").content,
        );
        validateSchemaValue(schema, example);
        assert.equal(Object.hasOwn(example, "payload"), false);
        assert.equal(Object.hasOwn(example.job, "output"), false);
        assert.match(
          pack.templates["portal-content"].content,
          /not a promise/u,
        );
        assert.match(
          pack.templates["portal-content"].content,
          /system of record/u,
        );
      }
    });
  });
}
