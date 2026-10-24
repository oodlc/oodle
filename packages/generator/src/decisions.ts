/**
 * Decisions the generator proposed while it built, against the ones already in the spec. A cheap
 * pass first (same words, or nearly, about the same things); a model judges only the near
 * matches. A proposal that contradicts a pinned decision is never merged: it becomes a
 * `decision_moved` gap for a person, and the build is blocked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from '@oodle/compile';
import { type Decision, decisionId } from '@oodle/spec';
import { parse } from 'yaml';
import { z } from 'zod';

export const PROPOSED = 'oodle/decisions.proposed.yaml';

export interface Proposal {
  text: string;
  about: string[];
}

const ProposalFile = z
  .array(
    z.union([
      z.string().transform((text) => ({ text, about: [] as string[] })),
      z.looseObject({ text: z.string().min(1), about: z.array(z.string()).default([]) }),
    ]),
  )
  .nullable();

/**
 * Agents write this file by hand, and don't always quote: `- text: Shows "Total: $40"` isn't valid
 * YAML. When it doesn't parse, each `- text:` line (and the `about:` after it) is read as written.
 */
function readLoosely(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const line of text.split('\n')) {
    const item = /^\s*-\s+(?:text:\s*)?(.+?)\s*$/.exec(line);
    const about = /^\s+about:\s*\[(.*)\]\s*$/.exec(line);
    if (about && out.length)
      (out[out.length - 1] as Proposal).about = (about[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    else if (item && !line.trim().startsWith('#')) out.push({ text: (item[1] as string).replace(/^(['"])(.*)\1$/, '$2'), about: [] });
  }
  return out;
}

export function readProposals(app: string): { proposals: Proposal[]; problem?: string } {
  const path = join(app, PROPOSED);
  if (!existsSync(path)) return { proposals: [] };
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    const loose = readLoosely(text);
    return loose.length ? { proposals: loose } : { proposals: [], problem: `${PROPOSED} isn't YAML, and no "- text:" lines could be read from it` };
  }
  const r = ProposalFile.safeParse(parsed);
  if (!r.success) return { proposals: [], problem: `${PROPOSED}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { proposals: (r.data ?? []).map((p) => ({ text: p.text.trim(), about: p.about })) };
}

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9$%.]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !['the', 'and', 'are', 'for', 'with', 'their', 'its'].includes(w)),
  );

function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size);
}

const overlaps = (a: string[], b: string[]) => a.length === 0 || b.length === 0 || a.some((r) => b.includes(r));

export interface Sorted {
  /** To append once the build passes verify. */
  fresh: Decision[];
  /** Already said by a decision in the spec. */
  duplicates: { proposal: Proposal; of: string }[];
  /** Would change a pinned decision: each becomes a decision_moved gap. */
  moved: { proposal: Proposal; pinned: Decision; reason: string }[];
}

const Judgement = z.strictObject({ verdict: z.enum(['same', 'contradicts', 'different']), reason: z.string() });

export async function sortProposals(proposals: Proposal[], existing: Decision[], opts: { buildId: string; model?: Model }): Promise<Sorted> {
  const out: Sorted = { fresh: [], duplicates: [], moved: [] };
  const known = existing.filter((d) => d.status !== 'dont_care');
  for (const p of proposals) {
    const id = decisionId(p.text);
    const exact = known.find((d) => d.id === id || d.text.trim().toLowerCase() === p.text.toLowerCase());
    if (exact) {
      out.duplicates.push({ proposal: p, of: exact.id });
      continue;
    }
    const near = known
      .map((d) => ({ d, s: similarity(d.text, p.text) }))
      .filter(({ d, s }) => s >= 0.3 && overlaps(d.about, p.about))
      .sort((a, b) => b.s - a.s);
    let placed = false;
    for (const { d, s } of near) {
      if (s >= 0.85) {
        out.duplicates.push({ proposal: p, of: d.id });
        placed = true;
        break;
      }
      if (!opts.model) continue;
      const j = await opts.model.json({
        label: 'judge decision',
        system: 'You compare two decisions about how an app behaves. Answer with JSON only.',
        prompt: `Existing decision (pinned): ${d.text}\nProposed decision: ${p.text}\n\nAre they the same behavior, does the proposal contradict the existing one (a build following it would break the existing one), or are they about different things?`,
        schema: Judgement,
      });
      if (j.verdict === 'same') out.duplicates.push({ proposal: p, of: d.id });
      else if (j.verdict === 'contradicts' && (d.status === 'pinned' || d.status === 'rule')) out.moved.push({ proposal: p, pinned: d, reason: j.reason });
      else continue;
      placed = true;
      break;
    }
    if (placed) continue;
    if (out.fresh.some((f) => f.id === id)) continue;
    out.fresh.push({ id, text: p.text, about: p.about, source: 'generator', status: 'pinned', created_by_build: opts.buildId });
  }
  return out;
}
