/**
 * Project settings: `oodle/oodle.config.yaml`. Everything has a default, so the file is optional.
 *
 *   routing:
 *     decided: agent        # agent | human: may a local agent settle decided-tier gaps?
 *     declared: human       # always human
 *     decision_moved: human # always human
 *   remote: { url: https://inbox.example.com, project: dogwalk }   # the token is never here
 *   explore: { cap: 200 }
 *   intents: { base: main } # the ref merged intents are read from
 *   model: claude-sonnet-5-5
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { SpecError } from './errors.ts';
import { SPEC_DIR } from './load.ts';

export const CONFIG_FILE = 'oodle.config.yaml';

export const Config = z.strictObject({
  routing: z
    .strictObject({
      decided: z.enum(['agent', 'human']).default('agent'),
      declared: z.literal('human', { error: 'declared-tier gaps always go to a person' }).default('human'),
      decision_moved: z.literal('human', { error: 'a moved decision always goes to a person' }).default('human'),
    })
    .default({ decided: 'agent', declared: 'human', decision_moved: 'human' }),
  remote: z.strictObject({ url: z.url(), project: z.string().min(1) }).optional(),
  explore: z.strictObject({ cap: z.number().int().positive().default(200) }).default({ cap: 200 }),
  intents: z.strictObject({ base: z.string().default('main') }).default({ base: 'main' }),
  model: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(root: string): Config {
  const path = join(root, SPEC_DIR, CONFIG_FILE);
  const raw = existsSync(path) ? (parse(readFileSync(path, 'utf8')) ?? {}) : {};
  const r = Config.safeParse(raw);
  if (!r.success) throw new SpecError(r.error.issues.map((i) => `${SPEC_DIR}/${CONFIG_FILE}: ${i.path.join('.')}: ${i.message}`));
  return r.data;
}
