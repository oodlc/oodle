/**
 * What is left of a captured body once nothing personal or secret is in it
 * (docs/decisions/0015). A stub needs the shape of an answer and the codes a
 * caller branches on, not anyone's data, so this keeps only what looks safe and
 * replaces everything else, rather than hunting for what looks dangerous:
 *
 * - keys, numbers, booleans and nulls stay, unless the key names a secret or a person;
 * - a string stays only when it looks like a code: lowercase, short, no long digit runs
 *   (`succeeded`, `usd`, `card_declined`);
 * - every other string becomes a placeholder chosen by what it looks like: an email,
 *   a card number, a phone number, an IP address, a token, or text.
 *
 * Placeholders are numbered by first appearance, so one value gets one placeholder
 * within a file and the same file always gives the same output. Nothing is hashed:
 * a hash of an email can be reversed by guessing. There is no way to keep real values.
 */

const CODE = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;
const SECRET_KEY = /pass(word|wd|phrase)?|secret|token|api_?key|apikey|^key$|private_?key|auth|cookie|session|signature|^otp$|^pin$|cvc|cvv|ssn|iban|account_?number|routing_?number/;
const PERSONAL_KEY = /(^|_)(name|first|last|given|family|display|full|nick|nickname|user|username|email|mail|phone|mobile|tel|telephone|address|line1|line2|street|city|postal|postcode|zip|birth|birthday|dob|holder|contact|ip)(_|$)/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]*:[0-9a-f:]+$/i;
const PHONE = /^\+?[\d\s().-]{10,20}$/;
const JWT = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/;
const SECRET_PREFIX = /^((sk|pk|rk|whsec|ghp|gho|ghs|github_pat|xox[abprs]|shpat|glpat)[_-][A-Za-z0-9_]{8,}|(AKIA|ASIA)[A-Z0-9]{12,}|AIza[\w-]{20,}|SG\.[\w-]{10,})/;
const ID_PREFIX = /^([a-z]{2,8})_/;

/** "userName" and "user-name" are both "user_name", so one pattern matches every spelling. */
const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s.]+/g, '_').toLowerCase();

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const isCard = (s: string) => {
  const digits = s.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digits) && luhn(digits);
};

/** A long run of letters and digits mixed, the way keys, session ids and signatures look. */
const looksLikeToken = (s: string) => JWT.test(s) || SECRET_PREFIX.test(s) || (/^[A-Za-z0-9_\-+/=.]{16,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s));

type Kind = 'email' | 'card' | 'phone' | 'ip' | 'token' | 'text' | 'key';

/** A Luhn-valid card number from a fixed test range: 400000000000000n plus its check digit. */
function testCard(n: number): string {
  const body = `400000000${String(n).padStart(6, '0')}`;
  for (let d = 0; d <= 9; d++) if (luhn(body + d)) return body + d;
  return `${body}0`;
}

export class Scrubber {
  private seen = new Map<string, string>();
  private counts = new Map<Kind, number>();

  private placeholder(kind: Kind, value: string): string {
    const memo = `${kind}\u0000${value}`;
    const known = this.seen.get(memo);
    if (known) return known;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const prefix = ID_PREFIX.exec(value)?.[1];
    const out =
      kind === 'email' ? `person${n}@example.test`
      : kind === 'card' ? testCard(n)
      : kind === 'phone' ? `+1555010${String(n).padStart(4, '0')}`
      : kind === 'ip' ? `192.0.2.${((n - 1) % 254) + 1}`
      : kind === 'token' ? (prefix && !SECRET_PREFIX.test(value) ? `${prefix}_placeholder${n}` : `token-${n}`)
      : kind === 'key' ? `key-${n}`
      : `text-${n}`;
    this.seen.set(memo, out);
    return out;
  }

  /** What a string looks like, when it isn't a code that can stay. */
  private kindOf(s: string): Kind {
    if (EMAIL.test(s)) return 'email';
    if (isCard(s)) return 'card';
    if (IP.test(s)) return 'ip';
    if (PHONE.test(s) && (s.match(/\d/g) ?? []).length >= 10) return 'phone';
    if (looksLikeToken(s)) return 'token';
    return 'text';
  }

  private string(s: string, key: string): string {
    const words = keyWords(key);
    if (SECRET_KEY.test(words)) return this.placeholder('token', s);
    if (!PERSONAL_KEY.test(words) && CODE.test(s) && !/\d{7,}/.test(s) && !looksLikeToken(s)) return s;
    return this.placeholder(this.kindOf(s), s);
  }

  private key(k: string): string {
    if (/^[A-Za-z_$][\w$-]{0,63}$/.test(k) && !looksLikeToken(k) && !/\d{7,}/.test(k)) return k;
    return this.placeholder('key', k);
  }

  /** A parsed body, scrubbed. Keys and structure stay; values follow the rules above. */
  value(v: unknown, key = ''): unknown {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      const words = keyWords(key);
      if (SECRET_KEY.test(words) || PERSONAL_KEY.test(words)) return 0;
      // A card number sent as a number is still a card number.
      return Number.isInteger(v) && isCard(String(v)) ? Number(testCard(1)) : v;
    }
    if (typeof v === 'string') return this.string(v, key);
    if (Array.isArray(v)) return v.map((x) => this.value(x, key));
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [this.key(k), this.value(x, k)]));
    return undefined;
  }
}

/**
 * A body from a capture, parsed and scrubbed: JSON, or a form. Anything else (HTML, binary,
 * XML) is dropped, because there is no shape to keep and no safe way to keep its text.
 */
export function scrubBody(scrubber: Scrubber, text: unknown, mimeType = '', encoding?: string, params?: unknown): unknown {
  if (Array.isArray(params) && params.length && !text) {
    return scrubber.value(Object.fromEntries(params.filter((p: any) => p?.name).map((p: any) => [String(p.name), String(p.value ?? '')])));
  }
  if (typeof text !== 'string' || !text) return undefined;
  let raw = text;
  if (encoding === 'base64') {
    try {
      raw = Buffer.from(text, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (/json/i.test(mimeType) || /^\s*[{[]/.test(raw)) {
    try {
      return scrubber.value(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  if (/x-www-form-urlencoded/i.test(mimeType)) return scrubber.value(Object.fromEntries(new URLSearchParams(raw)));
  return undefined;
}
