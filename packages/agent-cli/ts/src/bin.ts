#!/usr/bin/env node
import { ensureSupportedNode } from './node-version.js';

const status = ensureSupportedNode(process.versions.node, process.stderr, 'steerable-cli');
if (status !== 0) process.exit(status);

const { createCli } = await import('./cli.js');
process.exit(await createCli({ installSignals: true, commandName: 'steerable-cli' }));
