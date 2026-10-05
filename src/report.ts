import { stringify } from 'yaml';
import type { DiffReport } from './diff.ts';
import type { RunResult } from './types.ts';

const ICON: Record<string, string> = { held: '✅', changed: '🟡', broken: '❌', failing: '❌', new: '🆕', removed: '🗑️', redefined: '✏️' };

export function diffMarkdown(r: DiffReport): string {
  const count = (s: string) => r.outcomes.filter((o) => o.status === s).length;
  const lines: string[] = [];
  const headline = r.blocking ? `**${r.blocking} blocking**` : '**nothing blocking**';
  const drifted = r.behaviors.filter((b) => b.status !== 'held').length;
  lines.push(`## Outcome diff: ${headline}`);
  lines.push('');
  lines.push(`${count('held')} held · ${count('changed')} changed · ${count('broken') + count('failing')} broken · ${count('new')} new · ${count('removed')} removed · ${count('redefined')} redefined · ${r.gaps.length} unknown · ${drifted} behavior changes`);
  lines.push('');

  const notable = r.outcomes.filter((o) => o.status !== 'held');
  if (notable.length) {
    lines.push('| | Outcome | Boundary | What happened |');
    lines.push('| --- | --- | --- | --- |');
    for (const o of notable) {
      const what = o.details.map((d) => d.replace(/\|/g, '\\|')).join('<br>');
      lines.push(`| ${ICON[o.status]} ${o.status}${o.blocking ? ' **(blocking)**' : ''} | \`${o.id}\`<br>${o.statement} | ${o.boundary} | ${what} |`);
    }
    lines.push('');
  }

  if (r.constraints.length) {
    lines.push('### Constraint changes');
    lines.push('');
    for (const c of r.constraints) lines.push(`- ${ICON[c.status]} \`${c.id}\` ${c.status}${c.blocking ? ' **(blocking)**' : ''}: ${c.details.join('; ')}`);
    lines.push('');
  }

  const violating = [
    ...r.behaviors.filter((b) => b.blocking).map((b) => ({ where: `behavior \`${b.id}\``, violations: b.violations })),
    ...r.gaps.filter((g) => g.violations.length).map((g) => ({ where: `unknown route \`${g.route}\``, violations: g.violations })),
  ];
  if (violating.length) {
    lines.push('### Constraint violations (blocking)');
    lines.push('');
    lines.push('Constraints hold on every run, including behaviors and routes nobody described.');
    lines.push('');
    for (const v of violating) lines.push(`- ❌ ${v.where}: ${v.violations.join('; ')}`);
    lines.push('');
  }

  const inside = r.outcomes.filter((o) => o.behavior.length);
  const behaviors = r.behaviors.filter((b) => b.status !== 'held');
  if (inside.length || behaviors.length) {
    lines.push('### Behavior changes (report only)');
    lines.push('');
    lines.push('Observed by the runner, not durable. Promote a behavior to an outcome to protect it.');
    lines.push('');
    for (const o of inside) lines.push(`- under \`${o.id}\`: ${o.behavior.join('; ')}`);
    for (const b of behaviors) lines.push(`- \`${b.id}\` ${b.status}: ${b.details.join('; ')}`);
    lines.push('');
  }

  if (r.gaps.length) {
    lines.push('### Unknown: routes no outcome or behavior describes');
    lines.push('');
    lines.push('The runner probed these in simulation. Review each observed behavior, then promote it to an outcome, add it to the catalog as a behavior, or remove the route.');
    lines.push('');
    for (const g of r.gaps) {
      lines.push(`- \`${g.route}\` returned ${g.probe.status ?? `an error (${g.probe.error})`}`);
    }
    lines.push('');
    lines.push('```yaml');
    lines.push(stringify({ behaviors: r.gaps.map((g) => g.proposal) }).trimEnd());
    lines.push('```');
    lines.push('');
  }

  if (r.lint.errors.length || r.lint.warnings.length) {
    lines.push('### Catalog lint');
    lines.push('');
    for (const e of r.lint.errors) lines.push(`- ❌ ${e}`);
    for (const w of r.lint.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push('');
  }
  lines.push(`<sub>(${r.blocking ? '◕︵◕' : '^ᴗ^'})~ checked by Oodle · OODLC</sub>`);
  return lines.join('\n');
}

export function runSummary(run: RunResult): string {
  const lines: string[] = [];
  const obsOf = (kind: string, id: string) => run.observations.filter((o) => o.kind === kind && o.id === id);
  const timing = (obs: typeof run.observations) => obs.map((o) => `${o.condition} ${o.latency_ms}ms`).join(', ');

  for (const o of run.catalog.outcomes) {
    const obs = obsOf('outcome', o.id);
    const ok = obs.every((x) => x.failures.length === 0 && x.violations.length === 0);
    lines.push(`${ok ? '✅' : '❌'} ${o.id} (outcome, ${o.boundary}) · ${timing(obs)}`);
    for (const x of obs) for (const f of [...x.failures, ...x.violations]) lines.push(`     [${x.condition}] ${f}`);
  }
  for (const b of run.catalog.behaviors) {
    const obs = obsOf('behavior', b.id);
    const violated = obs.some((x) => x.violations.length);
    const drifted = obs.some((x) => x.failures.length);
    lines.push(`${violated ? '❌' : drifted ? '🟡' : '👀'} ${b.id} (behavior, ${b.boundary}) · ${timing(obs)}`);
    for (const x of obs) for (const v of x.violations) lines.push(`     [${x.condition}] ${v}`);
    for (const x of obs) for (const f of x.failures) lines.push(`     [${x.condition}] drift: ${f}`);
  }
  for (const g of run.gaps) {
    lines.push(`${g.violations.length ? '❌' : '❓'} ${g.route}: no outcome or behavior covers this route`);
    for (const v of g.violations) lines.push(`     [probe] ${v}`);
  }
  for (const e of run.lint.errors) lines.push(`lint error: ${e}`);
  for (const w of run.lint.warnings) lines.push(`lint warning: ${w}`);
  return lines.join('\n');
}
