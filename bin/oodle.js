#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so catalogs can point at TypeScript apps directly.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const result = spawnSync(process.execPath, [tsxCli, join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
