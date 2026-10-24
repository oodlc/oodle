/**
 * AGENTS.md: what the generator is told, written from the spec. In order: the declared tier
 * verbatim, the decisions it must keep, the rules, the vocabulary it must implement, and the stack
 * and what merged intents rule out.
 */
import type { Vocabulary } from '@oodle/compile';
import type { Spec } from '@oodle/spec';
import { stringify } from 'yaml';

export interface AgentsMdOptions {
  /** What merged intents rule out, in words. */
  ruledOut?: string[];
}

export function agentsMd(spec: Spec, vocab: Vocabulary, opts: AgentsMdOptions = {}): string {
  const declared = {
    intent: spec.intent,
    personas: spec.personas,
    domain: spec.domain,
    journeys: spec.journeys.map((j) => ({ id: j.id, persona: j.persona, steps: j.steps })),
    constraints: spec.constraints.map((c) =>
      c.check
        ? `${c.text}  (${c.check === 'build' ? 'checked on every build' : c.check === 'production' ? 'checked in production' : 'for you, the builder'})`
        : c.text,
    ),
  };
  const keep = spec.decisions.filter((d) => d.status === 'pinned' || d.status === 'rule');
  const stack = spec.constraints.filter((c) => c.check === 'generator').map((c) => c.text);

  return `# Build this app

You are generating a web app from its spec. People manage the spec; nobody will read your code to let it ship. It ships when the checks that come from the spec pass: every journey, every constraint checked on every build, and every decision below. Work on your own: there is no one to ask. If the spec is contradictory or impossible, write \`oodle/blocked.yaml\` (a \`reason:\` in plain words) and stop.

## The spec (declared by people)

\`\`\`yaml
${stringify(declared, { lineWidth: 0 }).trim()}
\`\`\`

## Decisions you must keep exactly

${keep.length ? keep.map((d) => `- ${d.text}${d.status === 'rule' ? ' (a rule a person set)' : ''}`).join('\n') : '- (none yet)'}

## Rules

1. Do not edit anything under \`oodle/\` except \`oodle/decisions.proposed.yaml\` (and \`oodle/blocked.yaml\` if you must stop).
2. Use \`@oodle/runtime\` for time, ids, randomness, mail and outbound HTTP: \`rt(c).now()\`, \`rt(c).id('walk')\`, \`rt(c).random()\`, \`rt(c).mail.send({ to, subject, text })\`, \`rt(c).fetch(url, init)\`, \`rt(c).log(event, data)\`. Never \`Date.now()\`, \`new Date()\` without an argument, \`Math.random()\`, \`crypto.randomUUID()\`, \`crypto.getRandomValues()\` or the global \`fetch\`: the build fails on them.
3. Keep all state in D1 (the \`DB\` binding), never in module variables. Add tables as numbered migrations in \`migrations/\` (\`0001_walks.sql\`, …); \`0000_oodle_users.sql\` is the runtime's and stays.
4. Keep \`app.use(oodle())\` first in \`src/index.tsx\`. People are persona users in the \`users\` table (id, persona, name, email, data as JSON for anything else, like an address); \`rt(c).user()\` is the signed-in one, or undefined. Don't build sign-up or real sign-in: that is a constraint people add later.
5. Render pages on the server with Hono JSX and plain HTML forms. No client-side framework or script. Every user-visible text goes in the HTML.
6. No new dependencies beyond \`hono\` and \`@oodle/runtime\`, and no outside services.
7. Implement every action and screen listed below in \`src/oodle.driver.ts\`, through HTTP only (\`s.fetch\`).
8. Wherever the spec is silent and you choose something a user could notice (an order, a format, a wording, what an empty screen says, who may do what beyond the spec, a limit), append a decision to \`oodle/decisions.proposed.yaml\`: one per behavior, in plain words a non-engineer can agree or disagree with, with \`about:\` refs. Don't record internal choices (names, file layout, libraries). Format:

   \`\`\`yaml
   - text: Walks are listed by starts_at, soonest first
     about: [entity:walk, screen:walks]
   \`\`\`

## The vocabulary: what the simulation does in your app

The simulation drives the app as each persona, through \`src/oodle.driver.ts\`. Each action gets a session \`s\` (signed in as one persona user: \`s.userId\`, and \`s.fetch(path, init)\` against the app) and its inputs, does what a user would do over HTTP, and returns the screen the user lands on. If the app refused the action (4xx), return no \`screen\` and the harness shows the page the app answered with. Return \`created\` for records an action creates, so later steps can refer to them.

Inputs that name a person are that user's id. Inputs that name a record are its id.

Actions:
${vocab.actions.map((a) => `- \`${a.id}\` (${a.persona}: "${a.capability}")${a.inputs.length ? ` inputs: ${a.inputs.map((i) => `\`${i}\``).join(', ')}` : ' no inputs'}${a.creates ? `; returns \`created: [{ kind: '${a.entity}', id }]\`` : ''}`).join('\n')}

Screens (name and params → the path to show):
${vocab.screens.map((s) => `- \`${s.name}\`${s.params.length ? ` (${s.params.map((p) => `\`${p}\``).join(', ')})` : ''}: ${s.shows}`).join('\n')}

\`\`\`ts
import type { Driver } from '@oodle/runtime';

export const driver: Driver = {
  actions: {
    'owner.book_walk': async (s, input) => {
      const res = await s.fetch('/walks', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ walker: String(input.walker) }).toString() });
      const to = res.headers.get('location');
      return to ? { screen: to, created: [{ kind: 'walk', id: to.split('/').pop()! }] } : {};
    },
  },
  screens: { home: () => '/', walk: (_s, p) => \`/walks/\${p.walk}\` },
};
\`\`\`

The compiled journeys in \`oodle/compiled/journeys/\` show exactly what the simulation will do and expect. Run \`pnpm check\` to run them (and every check) against your app; it must pass. Run \`pnpm typecheck\` too.

## Stack

- Hono on Cloudflare Workers with D1. Keep the template's \`wrangler.jsonc\` bindings.
${stack.map((s) => `- ${s}`).join('\n')}
${opts.ruledOut?.length ? `\n## Ruled out by merged intents\n\n${opts.ruledOut.map((r) => `- ${r}`).join('\n')}\n` : ''}`;
}
