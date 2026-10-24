import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCompiled } from '@oodle/compile';
import { describe, expect, it } from 'vitest';
import { DOGWALK_A, DOGWALK_B, variant } from '../../sim/test/fixtures/variants.ts';
import { determinismViolations, summarize, verify } from '../src/index.ts';

const compiled = readCompiled(join(import.meta.dirname, '../../../examples/dogwalk'));
const run = (dir: string) => verify(dir, compiled, { typecheck: false });

describe('oodle verify', () => {
  it('passes fixture A: every journey, constraint and pinned decision holds', async () => {
    const report = await run(DOGWALK_A);
    expect(summarize(report)).toMatch(/^passed: 1\/1 journeys, 5\/5 checks \(0 unchecked\)/);
    expect(report.passed).toBe(true);
    expect(report.journeys).toEqual({ 'first-booking': true });
    expect(report.findings.filter((f) => f.blocking)).toEqual([]);
    expect(report.stats.scenarios).toBe(1 + 40 + 3);
  });

  it('names the journey, the step and its prose line when a step fails', async () => {
    const dir = variant([{ why: 'cancelling says something else', file: 'src/index.tsx', from: "'Cancelled, no charge'", to: "'Cancelled'" }]);
    const report = await run(dir);
    expect(report.passed).toBe(false);
    expect(report.journeys['first-booking']).toBe(false);
    const finding = report.findings.find((f) => f.stage === 'journey');
    expect(finding).toMatchObject({ blocking: true, subject: 'first-booking' });
    expect(finding?.message).toBe(
      'step 3 ("Ada cancels on Monday at 18:00: she sees "Cancelled, no charge""), as owner:ada doing owner.cancel_walk: expected the screen to show "Cancelled, no charge"; it shows "Walk with Sam / Cancelled / Tue 3 Nov, 09:00, 30 minutes"',
    );
  });

  it('flags a planted Date.now(), with its file and line', async () => {
    const dir = variant([
      {
        why: 'time from the platform',
        file: 'src/index.tsx',
        from: "  const id = rt(c).id('walk');",
        to: "  const id = rt(c).id('walk');\n  const stamp = Date.now();\n  void stamp;",
      },
    ]);
    const line =
      readFileSync(join(dir, 'src/index.tsx'), 'utf8')
        .split('\n')
        .findIndex((l) => l.includes('Date.now()')) + 1;
    expect(determinismViolations(dir)).toEqual([{ file: 'src/index.tsx', line, what: 'Date.now() — use rt(c).now()' }]);
    const report = await run(dir);
    expect(report.passed).toBe(false);
    expect(report.findings.find((f) => f.stage === 'static')?.subject).toBe(`src/index.tsx:${line}`);
  });

  it('flags every way around the runtime, and only those', () => {
    const dir = variant([
      {
        why: 'every forbidden use, and some look-alikes',
        file: 'src/index.tsx',
        from: 'export const app = new Hono<OodleEnv>();',
        to: [
          'export const app = new Hono<OodleEnv>();',
          'const a = () => [new Date(), Date(), Math.random(), crypto.randomUUID(), globalThis.crypto.getRandomValues(new Uint8Array(1)), performance.now(), fetch("x"), globalThis.fetch("y")];',
          'const b = () => [new Date("2026-01-01"), "Date.now()", rt, Math.max(1, 2)]; // Date.now() in a comment',
          'void a; void b;',
        ].join('\n'),
      },
    ]);
    expect(determinismViolations(dir).map((v) => v.what.split(' — ')[0])).toEqual([
      'new Date() with no argument',
      'Date()',
      'Math.random()',
      'crypto.randomUUID()',
      'crypto.getRandomValues()',
      'performance.now()',
      'the global fetch',
      'the global fetch',
    ]);
  });

  it('fails dogwalk-b on the pinned decision it moved', async () => {
    const report = await run(variant(DOGWALK_B));
    expect(report.journeys['first-booking']).toBe(true);
    expect(report.passed).toBe(false);
    const moved = report.findings.filter((f) => f.stage === 'decision');
    expect(moved.map((f) => f.subject)).toEqual(['Walks are listed by starts_at, soonest first']);
    expect(moved[0]?.message).toMatch(/expected "Tue 3 Nov" before "Wed 4 Nov" before "Thu 5 Nov"/);
  });

  it('blocks a build whose driver misses part of the vocabulary', async () => {
    const dir = variant([{ why: 'no decline action', file: 'src/oodle.driver.ts', from: "    'walker.decline_walk':", to: "    'walker.decline_walk_x':" }]);
    const report = await run(dir);
    expect(report.findings).toContainEqual({
      stage: 'static',
      blocking: true,
      subject: 'src/oodle.driver.ts',
      message: 'the driver is missing action walker.decline_walk',
    });
  });
});
