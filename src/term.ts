/**
 * Terminal capabilities, decided once per stream: colour, unicode symbols,
 * width, and whether we may animate. Follows https://no-color.org,
 * FORCE_COLOR, TERM=dumb and the `--color` flag, in that order of precedence:
 * flag > NO_COLOR > FORCE_COLOR > TTY detection.
 */
import type { WriteStream } from 'node:tty';
import { runnable } from './invocation.ts';

export type ColorMode = 'auto' | 'always' | 'never';

export const settings = {
  color: 'auto' as ColorMode,
  /** Hush Oodle, hints and progress. Results still print. */
  quiet: false,
  /** Print stack traces and internal detail. */
  debug: false,
};

const env = process.env;

function colorFor(stream: NodeJS.WriteStream): boolean {
  if (settings.color === 'always') return true;
  if (settings.color === 'never') return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return !!stream.isTTY;
}

/** Unicode is safe almost everywhere except the Linux console and legacy Windows terminals. */
export const unicode = (() => {
  if (env.OODLE_ASCII) return false;
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  return !!(env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === '{cmd::Cmder}' || env.TERM_PROGRAM === 'vscode' || env.TERM === 'xterm-256color');
})();

const pick = (u: string, a: string) => (unicode ? u : a);
export const sym = {
  ok: pick('✔', '√'),
  fail: pick('✘', '×'),
  warn: pick('▲', '!'),
  info: pick('ℹ', 'i'),
  drift: pick('◆', '~'),
  watch: pick('●', '*'),
  unknown: pick('?', '?'),
  arrow: pick('→', '->'),
  pointer: pick('›', '>'),
  bar: pick('│', '|'),
  dot: pick('·', '-'),
  ellipsis: pick('…', '...'),
};

const SGR = {
  bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27],
  red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39],
} as const;
type StyleName = keyof typeof SGR;
export type Style = Record<StyleName, (s: string | number) => string> & { enabled: boolean; linkable: () => boolean; link: (text: string, url: string) => string };

function makeStyle(stream: NodeJS.WriteStream): Style {
  const style = {} as Style;
  Object.defineProperty(style, 'enabled', { get: () => colorFor(stream) });
  for (const [name, [open, close]] of Object.entries(SGR)) {
    (style as any)[name] = (s: string | number) => (colorFor(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  }
  // OSC 8 hyperlinks, only where we know the terminal renders them.
  const linkable = () => colorFor(stream) && !!stream.isTTY && !env.CI && /^(iTerm\.app|WezTerm|vscode|ghostty|Hyper)$/.test(env.TERM_PROGRAM ?? '');
  style.linkable = linkable;
  style.link = (text, url) => (linkable() ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text);
  return style;
}

/** Styles for results on stdout and for messages on stderr. They differ when one is piped. */
export const out = makeStyle(process.stdout);
export const err = makeStyle(process.stderr);

export const columns = (stream: NodeJS.WriteStream = process.stdout) => Math.max(40, Math.min((stream as WriteStream).columns || Number(env.COLUMNS) || 100, 140));

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
export const visible = (s: string) => s.replace(ANSI, '').length;
export const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visible(s)));

/** Messages, hints and progress go to stderr; results go to stdout. */
export const interactive = () => !!process.stderr.isTTY && !env.CI && env.TERM !== 'dumb';

export function note(line = ''): void {
  if (!settings.quiet) process.stderr.write(`${line}\n`);
}

/** "Next:" suggestions after a command, so the user always knows the next step. */
export function hints(lines: string[]): void {
  if (settings.quiet || !lines.length) return;
  note();
  for (const l of lines) note(`  ${err.dim(sym.arrow)} ${runnable(l)}`);
}

export function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A spinner on stderr for slow work. It only appears after a short grace period,
 * so fast commands never flicker, and never when stderr is not an interactive terminal.
 */
export function spinner(initial: string) {
  const frames = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];
  let text = initial;
  let i = 0;
  let shown = false;
  let timer: NodeJS.Timeout | undefined;
  const enabled = interactive() && !settings.quiet;
  const draw = () => {
    shown = true;
    const frame = err.cyan(frames[(i = (i + 1) % frames.length)]);
    const room = columns(process.stderr) - 3;
    // Truncate on visible characters, dropping styles, so an escape code is never cut in half.
    const body = visible(text) > room ? `${text.replace(ANSI, '').slice(0, room - 1)}${sym.ellipsis}` : text;
    process.stderr.write(`\r\x1b[2K${frame} ${body}`);
  };
  const start = enabled ? setTimeout(() => { draw(); timer = setInterval(draw, 80); }, 200) : undefined;
  const clear = () => {
    clearTimeout(start);
    clearInterval(timer);
    if (shown) process.stderr.write('\r\x1b[2K');
    shown = false;
  };
  activeSpinner = { clear };
  return {
    update(next: string) { text = next; },
    stop() { clear(); activeSpinner = undefined; },
  };
}

let activeSpinner: { clear: () => void } | undefined;
/** Used by the interrupt handler so its message is not drawn over a spinner. */
export const clearSpinner = () => activeSpinner?.clear();
