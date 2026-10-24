import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Gap, writeGap } from '@oodle/gaps';

export const EXAMPLE = join(import.meta.dirname, '../../../examples/dogwalk');

/** A scratch git repository holding the dogwalk spec, committed. */
export function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'oodle-sync-'));
  cpSync(join(EXAMPLE, 'oodle'), join(root, 'oodle'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'user.name', 'Ada');
  git('add', '.');
  git('commit', '-q', '-m', 'spec');
  return root;
}

export const log = (root: string) => execFileSync('git', ['-C', root, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');

const base = (over: Partial<Gap>): Gap => ({
  id: 'g_00000001',
  status: 'open',
  kind: 'sort_order',
  tier: 'decided',
  route: 'agent',
  spec_hash: 'h',
  found_in: ['build:a', 'build:b'],
  about: ['entity:walk', 'screen:walks'],
  question: 'Which order should owners see their walks in?',
  evidence: {
    scenario: 'explore/collections/walks-7',
    a: { summary: 'Soonest first', sample: ['Tue 3 Nov'] },
    b: { summary: 'Newest first', sample: ['Thu 5 Nov'] },
  },
  options: [
    { id: 'a', label: 'Soonest first', becomes: { decision: 'Walks are listed by starts_at, soonest first' } },
    { id: 'b', label: 'Newest first', becomes: { decision: 'Walks are listed newest booked first', replaces: 'Walks are listed by starts_at, soonest first' } },
    { id: 'dont_care', label: 'Either is fine' },
  ],
  answer: null,
  answered_by: null,
  answered_at: null,
  applied_in: null,
  ...over,
});

export const SORT = base({});
export const PERMISSION = base({
  id: 'g_00000002',
  kind: 'permission',
  tier: 'declared',
  route: 'human',
  about: ['entity:walk', 'action:owner.cancel_walk'],
  question: 'Can an owner cancel walks that belong to another owner?',
  options: [
    { id: 'a', label: 'Refuse it', becomes: { cannot: { persona: 'owner', text: 'cancel walks that belong to another owner' } } },
    { id: 'b', label: 'Allow it', becomes: { constraint: "Any owner can cancel walks, including another owner's" } },
  ],
});
export const WORDING = base({
  id: 'g_00000003',
  kind: 'wording',
  question: 'What should an empty list say?',
  options: [
    { id: 'a', label: '"No walks yet."', becomes: { decision: 'An empty walk list says "No walks yet."' } },
    { id: 'b', label: '"Nothing booked yet."', becomes: { decision: 'An empty walk list says "Nothing booked yet."' } },
    { id: 'dont_care', label: 'Either is fine' },
  ],
});

export function withGaps(root: string, ...gaps: Gap[]) {
  for (const g of gaps) writeGap(root, g);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'gaps']);
}
