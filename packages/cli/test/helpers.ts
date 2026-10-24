import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/main.ts';

export const EXAMPLE = join(import.meta.dirname, '../../../examples/dogwalk');

/** A scratch git repository on main holding the dogwalk spec. */
export function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'oodle-cli-'));
  cpSync(join(EXAMPLE, 'oodle'), join(root, 'oodle'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.oodle/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'ada@example.com');
  git(root, 'config', 'user.name', 'Ada');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'spec');
  return root;
}

export const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Runs the CLI in-process with --json, and returns its exit code and answer. */
export async function oodle(root: string, ...args: string[]): Promise<{ code: number; out: any }> {
  let text = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    text += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(['node', 'oodle', '--root', root, '--json', ...args]);
    return { code, out: text ? JSON.parse(text) : undefined };
  } finally {
    process.stdout.write = write;
  }
}

/** Recorded answers for the local agent. */
export function scriptedAnswers(dir: string, answers: Record<string, unknown>): string {
  const path = join(dir, 'answers.json');
  writeFileSync(path, JSON.stringify(answers));
  return path;
}
