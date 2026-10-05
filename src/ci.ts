/**
 * GitHub Actions integration, on automatically when GITHUB_ACTIONS=true:
 * blocking findings become annotations on the run, lint findings point at
 * their catalog file, and diff markdown lands in the job summary.
 * Workflow commands go to stderr so stdout stays clean for --json.
 */
import { appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DiffReport } from './diff.ts';
import type { LintResult, RunResult } from './types.ts';

export const inGitHubActions = () => process.env.GITHUB_ACTIONS === 'true';

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function annotate(level: 'error' | 'warning' | 'notice', message: string, props: { title?: string; file?: string } = {}): void {
  const p = Object.entries(props).filter(([, v]) => v).map(([k, v]) => `${k}=${escapeProp(v!)}`).join(',');
  process.stderr.write(`::${level}${p ? ` ${p}` : ''}::${escapeData(message)}\n`);
}

function lintAnnotations(projectDir: string, lint: LintResult): void {
  for (const [level, list] of [['error', lint.errors], ['warning', lint.warnings]] as const) {
    for (const l of list) {
      const i = l.indexOf(': ');
      const file = i > 0 ? relative(process.cwd(), join(projectDir, l.slice(0, i))) : undefined;
      annotate(level, i > 0 ? l.slice(i + 2) : l, { title: `Oodle catalog ${level}`, file });
    }
  }
}

export function annotateLint(projectDir: string, lint: LintResult): void {
  if (inGitHubActions()) lintAnnotations(projectDir, lint);
}

export function annotateRun(run: RunResult): void {
  if (!inGitHubActions()) return;
  for (const o of run.observations) {
    const problems = [...(o.kind === 'outcome' ? o.failures : []), ...o.violations];
    if (problems.length) annotate('error', problems.join('\n'), { title: `Oodle: ${o.kind} ${o.id} [${o.condition}]` });
  }
  for (const g of run.gaps) {
    if (g.violations.length) annotate('error', g.violations.join('\n'), { title: `Oodle: unknown route ${g.route}` });
    else annotate('notice', 'No outcome or behavior describes this route.', { title: `Oodle: unknown route ${g.route}` });
  }
  lintAnnotations(run.projectDir, run.lint);
}

export function annotateDiff(report: DiffReport, headDir: string, markdown: string): void {
  if (!inGitHubActions()) return;
  for (const o of report.outcomes) if (o.blocking) annotate('error', o.details.join('\n'), { title: `Oodle: outcome ${o.id} ${o.status}` });
  for (const c of report.constraints) if (c.blocking) annotate('error', c.details.join('\n'), { title: `Oodle: constraint ${c.id} ${c.status}` });
  for (const b of report.behaviors) if (b.blocking) annotate('error', b.violations.join('\n'), { title: `Oodle: behavior ${b.id} violates a constraint` });
  lintAnnotations(headDir, report.lint);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
