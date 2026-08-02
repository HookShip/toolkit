# Toolkit source evaluation

Use this guide for a focused evaluation of HookShip's public contract and
developer-experience toolkit. It uses the repository source and synthetic
fixtures only; no registry account, hosted service, production webhook, or
private repository is required.

HookShip is pre-release. Record the exact commit you test because package
versions are release candidates, not published artifacts.

## Time and prerequisites

Allow 30-60 minutes.

- Node.js 22 or newer
- Corepack
- Git
- A clean source checkout

Docker is not required for the core evaluation.

## 1. Record the environment

```sh
git rev-parse HEAD
node --version
corepack --version
```

Include these values in feedback so results are reproducible.

## 2. Install and run the end-to-end smoke

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm smoke
```

The smoke workflow validates, imports, publishes, and compares a synthetic
contract; generates a fixture and TypeScript types; signs and verifies a
payload; exercises endpoint and secret lifecycle; sends a signed test; ingests
metadata; and reads the resulting timeline in memory.

Expected result: the command exits zero without requesting credentials or
network access to a HookShip service.

## 3. Try the contract CLI directly

```sh
pnpm build
node packages/cli/dist/bin.js validate \
  examples/contracts/orders.openapi.yaml
node packages/cli/dist/bin.js fixture \
  examples/contracts/orders.openapi.yaml \
  --event order.created \
  --version 1
```

Inspect whether:

- the command names and output make the workflow discoverable;
- validation errors would tell you what to fix;
- the generated fixture is useful without hand-editing; and
- the repository boundary between toolkit and delivery service is clear.

## 4. Optional package-consumer check

If you can spend another 15-30 minutes:

```sh
pnpm pack:smoke
```

This packs all 14 public package candidates, installs their tarballs together in
a clean project, imports every public entry point, and invokes the packed CLI.
It does not publish anything.

## Evaluation checklist

- [ ] I could identify which repository owns the behavior I tested.
- [ ] Installation and the first useful command were understandable.
- [ ] The smoke workflow completed, or I captured the exact first blocker.
- [ ] The CLI made contract validation and fixture generation understandable.
- [ ] Errors and next actions were actionable.
- [ ] I can state one workflow where the toolkit is useful, or why it is not a
      fit.

## Safe feedback

Use only the included synthetic examples. Do not post proprietary contracts,
payloads, endpoint URLs, tokens, signing secrets, private logs, or personal
data.

- Submit cross-project experience feedback through the
  [early evaluation form](https://github.com/HookShip/.github/issues/new?template=evaluation_feedback.yml).
- File a reproducible toolkit defect through the
  [bug report form](https://github.com/HookShip/toolkit/issues/new?template=bug_report.yml).
- Report vulnerabilities through [`SECURITY.md`](../SECURITY.md), never a public
  issue.

Useful feedback names the exact commit, environment, elapsed time, attempted
workflow, first confusing or failing step, sanitized observed behavior, and the
decision you would make next.
