#!/usr/bin/env node
// Registers tsx in-process, so catalogs can point at TypeScript apps directly
// and Ctrl-C, exit codes and TTY detection belong to a single process.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
