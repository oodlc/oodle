/**
 * Fixture apps as edits of dogwalk-a, so what makes each one different is written down in one place.
 * dogwalk-b is the second hand-written implementation the gaps check is tested against: it differs
 * from A in exactly the three ways listed, and nowhere else.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DOGWALK_A = join(import.meta.dirname, 'dogwalk-a');

export interface Edit {
  file: string;
  from: string;
  to: string;
  /** What the edit plants, in words. */
  why: string;
}

export const DOGWALK_B: Edit[] = [
  { why: 'sort order: walks are listed newest first', file: 'src/index.tsx', from: 'ORDER BY w.starts_at ASC, w.seq ASC', to: 'ORDER BY w.seq DESC' },
  {
    why: "permission: any owner can cancel any owner's walk",
    file: 'src/index.tsx',
    from: 'if (!user || !w || w.owner_id !== user.id) return message(c, 403, "You can\'t cancel this walk.");',
    to: "if (!user || !w || user.persona !== 'owner') return message(c, 403, \"You can't cancel this walk.\");",
  },
  { why: 'wording: the empty list says something else', file: 'src/index.tsx', from: '<p>No walks yet.</p>', to: '<p>Nothing booked yet.</p>' },
];

/** A copy of dogwalk-a with edits applied, in a temporary folder. */
export function variant(edits: Edit[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'oodle-fixture-'));
  cpSync(DOGWALK_A, dir, { recursive: true });
  for (const e of edits) {
    const path = join(dir, e.file);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(e.from)) throw new Error(`fixture edit "${e.why}" found nothing to change in ${e.file}`);
    writeFileSync(path, text.replace(e.from, e.to));
  }
  return dir;
}
