#!/usr/bin/env node
import { createCli } from './cli.js';

process.exit(await createCli({ installSignals: true }));
