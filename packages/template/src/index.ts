/**
 * @oodle/template: the Hono + D1 app every build starts from. Server-rendered with Hono JSX, no
 * client framework, so what a user sees can be read from the HTML. It has the runtime wired in,
 * the persona users table, an error page, and an empty driver for the generator to fill in.
 */
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The template's files: dist/index.js and src/index.ts both sit one level under the package. */
export const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'files');

/** Copies the template into `dest`, which may already exist. */
export function copyTemplate(dest: string): void {
  cpSync(TEMPLATE_DIR, dest, { recursive: true });
}
