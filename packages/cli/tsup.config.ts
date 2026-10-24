import { defineConfig } from 'tsup';

export default defineConfig({ entry: ['src/index.ts', 'src/bin.ts'], format: ['esm'], clean: true });
