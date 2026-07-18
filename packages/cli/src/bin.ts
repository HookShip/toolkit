#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2));
