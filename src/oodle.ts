/**
 * Oodle, the OODLC mascot: a small noodle with a curl on top and a wiggly tail,
 * who watches the catalog. Outcomes are what Oodle protects; behaviors are what
 * Oodle notices. Oodle is calm, plain-spoken and a little delighted by tidy
 * catalogs. Never cutesy about real breakage: when an outcome breaks, Oodle says
 * what broke and stops there.
 *
 * Oodle only talks on stderr, so stdout stays clean for --json and markdown,
 * and stays quiet when stderr is not a terminal or OODLE_QUIET is set.
 * Animation is skipped in CI or when OODLE_STILL is set. Colour follows term.ts
 * (NO_COLOR, FORCE_COLOR, --color).
 */
import { err, settings } from './term.ts';

export type Mood = 'hello' | 'happy' | 'worried' | 'curious' | 'oops' | 'blink';

const FACE: Record<Mood, string> = {
  hello: '◕ ᴗ ◕',
  happy: '^ ᴗ ^',
  worried: '◕ ︵ ◕',
  curious: '◕ ‿ •',
  oops: '× _ ×',
  blink: '– ᴗ –',
};

/** 256-colour body tint per mood: teal, amber, violet, coral. */
const TINT: Record<Mood, number> = { hello: 43, happy: 43, blink: 43, worried: 214, curious: 141, oops: 203 };

const env = process.env;
const colorOn = () => err.enabled;
const paint = (code: string, text: string) => (colorOn() ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Plain text frames; tail wiggles between `~` and `≈`. */
export function avatar(mood: Mood = 'hello', tail = '~'): string[] {
  return [
    '      ∿',
    '   ╭───────╮',
    `  ( ${FACE[mood]} )${tail}`,
    '   ╰─┬───┬─╯',
    '     ╵   ╵',
  ];
}

const FACE_ROW = 2;

/** Oodle with a speech bubble beside the face. Coloured when the terminal allows it. */
export function speak(mood: Mood, message: string, tail = '~'): string {
  const art = avatar(mood, tail);
  const width = Math.max(...art.map((l) => l.length));
  const tint = `38;5;${TINT[mood]}`;
  return art.map((line, i) => (i === FACE_ROW && message ? `${paint(tint, line.padEnd(width))}  ${paint('1', message)}` : paint(tint, line))).join('\n');
}

const quiet = () => settings.quiet || !!env.OODLE_QUIET || !process.stderr.isTTY;
const still = () => !!env.CI || !!env.OODLE_STILL || env.TERM === 'dumb' || !colorOn();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Draws frames in place, then leaves the last one on screen. */
async function animate(frames: string[], ms: number): Promise<void> {
  const height = frames[0].split('\n').length;
  process.stderr.write(`\n${frames[0]}\n`);
  for (const f of frames.slice(1)) {
    await sleep(ms);
    process.stderr.write(`\x1b[${height}A${f.split('\n').map((l) => `\x1b[2K${l}`).join('\n')}\n`);
  }
}

/** Oodle reacts: a quick blink, then the mood. */
export async function say(mood: Mood, message: string): Promise<void> {
  if (quiet()) return;
  if (still()) return void process.stderr.write(`\n${speak(mood, message)}\n`);
  await animate([speak('blink', message, '≈'), speak(mood, message, '~')], 140);
}

/** `oodle hello`: Oodle waves and explains the deal. */
export async function hello(): Promise<void> {
  const lines = [
    "Hi, I'm Oodle!",
    'You declare outcomes. I watch behaviors.',
    'Break an outcome and I stop the merge. Behavior drifts and I just tell you.',
  ];
  if (quiet() || still()) {
    process.stderr.write(`\n${speak('hello', lines[0])}\n\n  ${lines.slice(1).join('\n  ')}\n`);
    return;
  }
  const frames: string[] = [];
  for (let i = 0; i < 6; i++) frames.push(speak(i === 3 ? 'blink' : i % 2 ? 'happy' : 'hello', lines[0], i % 2 ? '≈' : '~'));
  await animate(frames, 160);
  process.stderr.write(`\n  ${lines.slice(1).join('\n  ')}\n`);
}
