/** The little git Oodle needs: is this a repository, is the spec clean, commit, read a file at a ref. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function isRepo(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** Uncommitted changes under a path, as `git status --porcelain` lines. */
export function dirty(root: string, path: string): string[] {
  if (!isRepo(root)) return [];
  const out = git(root, ['status', '--porcelain', '--', path]);
  return out ? out.split('\n') : [];
}

/** Commits these paths (only these) and returns the new commit's sha, or undefined when there was nothing to commit. */
export function commit(root: string, paths: string[], message: string): string | undefined {
  if (!isRepo(root)) return undefined;
  const tracked = git(root, ['ls-files', '--', ...paths]);
  paths = paths.filter((p) => existsSync(join(root, p)) || tracked.split('\n').some((f) => f.startsWith(p)));
  if (!paths.length) return undefined;
  git(root, ['add', '--all', '--', ...paths]);
  const staged = git(root, ['diff', '--cached', '--name-only', '--', ...paths]);
  if (!staged) return undefined;
  git(root, ['commit', '--quiet', '--only', '-m', message, '--', ...paths]);
  return git(root, ['rev-parse', 'HEAD']);
}

export function headSha(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

export function userEmail(root: string): string | undefined {
  try {
    return git(root, ['config', 'user.email']) || undefined;
  } catch {
    return undefined;
  }
}

/** A file's content at a ref, or undefined when it isn't there. `path` is relative to the repository root. */
export function show(root: string, ref: string, path: string): string | undefined {
  try {
    return git(root, ['show', `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Files under a directory at a ref, relative to the repository root. */
export function listAt(root: string, ref: string, dir: string): string[] {
  try {
    const out = git(root, ['ls-tree', '--name-only', `${ref}`, `${dir.replace(/\/$/, '')}/`]);
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

/** The path of `abs` relative to the repository root. */
export function repoPath(root: string, rel: string): string {
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  return `${prefix}${rel}`;
}
