/**
 * The drafter. Oodle does not call a model itself: it writes the prompt that
 * turns a brief (a PRD, a ticket, a paragraph) into a catalog proposal, with
 * everything a model needs to know about this project's catalog. Pipe it to any
 * agent and feed the YAML that comes back to `oodle propose`, or let an agent
 * connected to `oodle mcp` use the `draft` prompt and the `propose` tool:
 *
 *   oodle draft brief.md | claude -p > draft.yaml && oodle propose draft.yaml
 *
 * Whatever comes back is a proposal: it runs and is reported, but blocks
 * nothing until a human approves it. See docs/decisions/0006.
 */
import { stringify } from 'yaml';
import { loadCatalog, loadConfig } from './catalog.ts';
import { BUILTIN_CONDITIONS } from './security.ts';

const list = (items: { id: string; statement?: string }[]) => (items.length ? items.map((i) => `- \`${i.id}\`${i.statement ? `: ${i.statement}` : ''}`).join('\n') : '- (none yet)');

export function draftPrompt(projectDir: string, brief: string): string {
  const config = loadConfig(projectDir);
  const catalog = loadCatalog(projectDir, config);
  const stubs = Object.keys(config.defaults?.given?.stubs ?? {});
  const triggers = [...new Set([...catalog.outcomes, ...catalog.behaviors].map((x) => x.trigger.http))];
  const example = catalog.outcomes.find((o) => o.status !== 'proposed');

  return `You are drafting OODLC catalog entries for a brief. Oodle will run what you draft against the app in a sealed simulation.

# The rules

- **Intents** say why the product exists. **Outcomes** say what someone outside the system must experience: a customer, an external caller, owned data, an obligation. Every outcome traces to an intent.
- Describe what can be observed at the boundary: the HTTP status, response body fields, and effects (\`email.sent\`, \`payment.capture\`, ...). Never describe internals: function names, internal effects (\`internal.*\`), log lines.
- One outcome per promise. Prefer a few sharp outcomes over many vague ones. Use \`conditions\` for variants of the same promise (a slow provider, a returning customer), and \`when\` to say what a condition should change, e.g. \`when: { security.no-credentials: { status: 401 } }\`.
- Add **constraints** for invariants that must hold on every run, written as a JS expression over \`effects\`, \`state\`, \`response\` and \`request\`, e.g. \`effects.filter(e => e.kind === 'payment.capture').length <= 1\`.
- Think about failure and abuse, not only the happy path: what happens when a dependency fails, when the request is replayed, when credentials are missing, when the input is hostile.
- Only add entries. Never restate or change an existing id; reuse existing intents and conditions where they fit.
- Everything you draft is a proposal. A human approves it before it can block a merge.

# This project

App: \`${config.app}\`

Intents:
${list(catalog.intents)}

Outcomes:
${list(catalog.outcomes)}

Behaviors (observed, not promised):
${list(catalog.behaviors)}

Conditions:
${list(catalog.conditions)}

Built-in security conditions:
${list(BUILTIN_CONDITIONS)}

Constraints:
${list(catalog.constraints)}

Triggers already described: ${triggers.length ? triggers.map((t) => `\`${t}\``).join(', ') : '(none)'}
External calls the app makes (stubbed in simulation): ${stubs.length ? stubs.map((s) => `\`${s}\``).join(', ') : '(none declared)'}
${example ? `\nAn existing outcome, for the shape:\n\n\`\`\`yaml\n${stringify({ outcomes: [example] }).trimEnd()}\n\`\`\`\n` : ''}
Field reference: outcome = { id, intent, statement, boundary: customer|external|data|obligation|internal, trigger: { http: "METHOD /path", given: { body, headers, state, stubs } }, conditions?, expect: { status, body: { field: value | { exists, type, matches, contains, gte, lte } }, effects: [{ kind, match?, count }], latency_ms_max? }, when?, constraints? }. Ids are lowercase with dots or dashes.

# The brief

${brief.trim()}

# Your answer

Reply with one YAML document and nothing else: a mapping with any of \`intents\`, \`outcomes\`, \`conditions\`, \`constraints\`. No prose, no code fences.
`;
}
