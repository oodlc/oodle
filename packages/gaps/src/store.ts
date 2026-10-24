/**
 * Gap files on disk, and the ignore list. A gap's id is its signature, so finding the same
 * difference again updates the same file: an open gap gets fresh evidence, an answered one is
 * left alone, and a dismissed signature (in `.ignore.yaml`) is never raised again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { specDir, stableStringify } from '@oodle/spec';
import { parse, stringify } from 'yaml';
import { GAP_KEYS, Gap } from './gap.ts';

export const gapsDir = (root: string) => join(specDir(root), 'gaps');
const IGNORE = '.ignore.yaml';

export function readGaps(root: string): Gap[] {
  const dir = gapsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^g_[0-9a-f]+\.yaml$/.test(f))
    .sort()
    .map((f) => {
      const r = Gap.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
      if (!r.success) throw new Error(`oodle/gaps/${f}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return r.data;
    });
}

export function readGap(root: string, id: string): Gap | undefined {
  return readGaps(root).find((g) => g.id === id);
}

export function gapPath(root: string, id: string) {
  return join(gapsDir(root), `${id}.yaml`);
}

export function writeGap(root: string, gap: Gap): string {
  mkdirSync(gapsDir(root), { recursive: true });
  const ordered: Record<string, unknown> = {};
  for (const k of GAP_KEYS) if ((gap as Record<string, unknown>)[k] !== undefined) ordered[k] = (gap as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(gap)) if (!(k in ordered) && v !== undefined) ordered[k] = v;
  const path = gapPath(root, gap.id);
  writeFileSync(path, stringify(ordered, { lineWidth: 0 }));
  return path;
}

export function removeGap(root: string, id: string) {
  rmSync(gapPath(root, id), { force: true });
}

export interface Ignored {
  id: string;
  reason?: string;
  by?: string;
}

export function readIgnore(root: string): Ignored[] {
  const path = join(gapsDir(root), IGNORE);
  return existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as Ignored[] | null) ?? []) : [];
}

export function addIgnore(root: string, entry: Ignored) {
  const all = readIgnore(root).filter((e) => e.id !== entry.id);
  all.push(entry);
  mkdirSync(gapsDir(root), { recursive: true });
  writeFileSync(join(gapsDir(root), IGNORE), `# Differences people said nobody would notice. The gaps check doesn't raise them again.\n${stringify(all)}`);
}

/** The gap without its answer fields: what the inbox's content_hash covers. */
export function contentHash(gap: Gap): string {
  const { answer: _a, answered_by: _b, answered_at: _c, applied_in: _d, status: _e, history: _f, ...rest } = gap;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}
