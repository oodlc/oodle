#!/usr/bin/env node
// Registers tsx in-process, so catalogs can point at TypeScript apps directly
// and Ctrl-C, exit codes and TTY detection belong to a single process. Both
// hooks are needed: an app with no "type": "module" loads through require().
import { register as registerEsm } from 'tsx/esm/api';
import { register as registerCjs } from 'tsx/cjs/api';

registerCjs();
registerEsm();
await import('../src/cli.ts');
