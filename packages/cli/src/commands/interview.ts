/**
 * `oodle interview`: writes the declared tier in a conversation, at a terminal. It asks for the
 * intent, the personas and what each can do, the things the app holds (a model suggests them from
 * the capabilities; the person decides), one journey per persona with real values, and the
 * constraints. The spec is validated after every write. It never writes decisions: those come from
 * builds and from the gaps check, which is the interview's second half.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import type { Model } from '@oodle/compile';
import { loadSpec, SINGLE_FILE, SPEC_DIR } from '@oodle/spec';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { CliError, type Ctx, done, NeedsPerson } from '../context.ts';

const list = (answer: string) =>
  answer
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export interface Asker {
  ask(question: string): Promise<string>;
  say(text: string): void;
}

/** Writes one section of oodle/spec.yaml (made when there is none), and checks the spec still loads. */
function writeSection(root: string, section: string, value: unknown) {
  const dir = join(root, SPEC_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SINGLE_FILE);
  if (!existsSync(path) && existsSync(join(dir, 'intent.yaml')))
    throw new CliError('The interview writes oodle/spec.yaml; this spec uses one file per section. Edit those files instead.');
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (!doc.contents) doc.contents = doc.createNode({}) as never;
  doc.set(section, doc.createNode(value));
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  try {
    loadSpec(root);
  } catch (e) {
    if (before === undefined) writeFileSync(path, '');
    else writeFileSync(path, before);
    throw e;
  }
}

const Entities = z.strictObject({
  entities: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z_]*$/), fields: z.array(z.string()), states: z.string().optional() })),
});

async function suggestEntities(model: Model | undefined, intent: string, personas: Record<string, { can: string[] }>) {
  if (!model) return [];
  try {
    const r = await model.json({
      label: 'interview entities',
      system: 'You help someone describe the app they want. Answer with JSON only.',
      prompt: `Intent: ${intent}\nPersonas and what they can do:\n${Object.entries(personas)
        .map(([p, v]) => `- ${p}: ${v.can.join('; ')}`)
        .join(
          '\n',
        )}\n\nWhat things does the app hold? Give each a singular lowercase name, the fields a user would recognise (persona names as fields where a person is involved), and its states as "a -> b -> c | d" if it moves through any.`,
      schema: Entities,
    });
    return r.entities;
  } catch {
    return [];
  }
}

export async function runInterview(root: string, io: Asker, model?: Model): Promise<void> {
  io.say(
    "Let's write what the app is for, who uses it, what it holds, what they go through and what must never happen. Leave an answer empty to keep a suggestion.\n",
  );

  const intent = await io.ask('In one sentence, why does the app exist? ');
  if (!intent) throw new CliError('The intent is the one thing the interview needs.');
  writeSection(root, 'intent', intent);

  const names = list(await io.ask('Who uses it? Name the kinds of people, separated by commas (owner, walker): '));
  const personas: Record<string, { can: string[] }> = {};
  for (const name of names.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_'))) {
    personas[name] = { can: list(await io.ask(`What can a ${name} do? Separate with commas (book walks, cancel their own walks): `)) };
  }
  writeSection(root, 'personas', personas);

  const domain: Record<string, { fields: Record<string, null | (string | number)[]>; states?: string; rules: string[] }> = {};
  const suggested = await suggestEntities(model, intent, personas);
  const entityNames = suggested.length
    ? list(
        (await io.ask(`The app seems to hold: ${suggested.map((e) => e.name).join(', ')}. Which things does it hold? `)) ||
          suggested.map((e) => e.name).join(', '),
      )
    : list(await io.ask('What things does the app hold? Singular names, separated by commas (walk): '));
  for (const entity of entityNames) {
    const hint = suggested.find((e) => e.name === entity);
    const fields = list((await io.ask(`Fields of a ${entity}${hint ? ` [${hint.fields.join(', ')}]` : ''}: `)) || (hint?.fields.join(', ') ?? ''));
    const states =
      (await io.ask(
        `States a ${entity} moves through, like "requested -> accepted -> done | cancelled"${hint?.states ? ` [${hint.states}]` : ''} (empty for none): `,
      )) ||
      hint?.states ||
      '';
    const rules: string[] = [];
    for (;;) {
      const rule = await io.ask(`A rule about ${entity}s (empty when done): `);
      if (!rule) break;
      rules.push(rule);
    }
    domain[entity] = { fields: Object.fromEntries(fields.map((f) => [f, null])), ...(states ? { states } : {}), rules };
    writeSection(root, 'domain', domain);
  }

  const journeys: { id: string; persona: string; steps: string[] }[] = [];
  for (const persona of Object.keys(personas)) {
    io.say(
      `\nWalk me through a ${persona}'s first time, one step per line, with real names and values ("Ada picks Sam for Tuesday 9:00, 30 minutes: she sees \\"Requested, $20\\""). An empty line ends it.`,
    );
    const steps: string[] = [];
    for (;;) {
      const step = await io.ask('  ');
      if (!step) break;
      steps.push(step);
    }
    if (steps.length) journeys.push({ id: `first-${persona.replace(/_/g, '-')}`, persona, steps });
  }
  if (journeys.length) writeSection(root, 'journeys', journeys);

  const constraints = (await io.ask('\nWhat must never happen? Separate with semicolons: '))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const stack = await io.ask('Does the stack matter (for example "Runs on Cloudflare Workers with D1")? Empty if not: ');
  writeSection(root, 'constraints', [...constraints, ...(stack ? [stack] : [])]);

  io.say(
    `\nWrote oodle/${SINGLE_FILE}:\n\n${readFileSync(join(root, SPEC_DIR, SINGLE_FILE), 'utf8')}\nNext: \`oodle compile\`, then \`oodle build\` and \`oodle gaps\`.`,
  );
}

export async function interviewCommand(ctx: Ctx): Promise<number> {
  if (!ctx.tty) throw new NeedsPerson('writing the spec in an interview', ctx.config);
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runInterview(ctx.root, { ask: (q) => rl.question(q).then((a) => a.trim()), say: (t) => process.stdout.write(`${t}\n`) }, ctx.model());
  } finally {
    rl.close();
  }
  return done(ctx, { written: `${SPEC_DIR}/${SINGLE_FILE}` });
}
