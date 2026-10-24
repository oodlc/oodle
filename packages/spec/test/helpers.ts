import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
export const README_EXAMPLE = join(here, 'fixtures/readme');
export const DOGWALK = join(here, '../../../examples/dogwalk');

/** A scratch copy of a project, so a test can edit its spec. */
export function copyProject(from: string): string {
  const to = mkdtempSync(join(tmpdir(), 'oodle-spec-'));
  cpSync(join(from, 'oodle'), join(to, 'oodle'), { recursive: true });
  return to;
}

/** Edits one file under the project's oodle/ folder. */
export function edit(root: string, file: string, fn: (text: string) => string) {
  const path = join(root, 'oodle', file);
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`edit of ${file} changed nothing`);
  writeFileSync(path, after);
}

export const read = (root: string, file: string) => readFileSync(join(root, 'oodle', file), 'utf8');
export const write = (root: string, file: string, text: string) => writeFileSync(join(root, 'oodle', file), text);
