import { type Expect, type Fixture, idOf, type Observation, screenText, type ViewModel } from '@oodle/sim';

export const emailOf = (key: string, f: Fixture | undefined) => f?.email ?? `${idOf(key)}@example.com`;

/** A short account of a screen, for failure messages. */
export function describeView(v: ViewModel): string {
  const parts = [...v.headings, ...v.text, ...v.lists.flatMap((l) => l.items)].slice(0, 6);
  const text = parts.join(' / ');
  return text ? `"${text.length > 200 ? `${text.slice(0, 197)}...` : text}"` : 'an empty screen';
}

/** What didn't hold. Empty when every expectation did. */
export function unmet(expect: Expect | undefined, obs: Observation, fixtures: Record<string, Fixture>): string[] {
  if (obs.error) return [obs.error];
  if (!expect) return [];
  const out: string[] = [];
  const text = screenText(obs.view);
  const shows = () => describeView(obs.view);
  for (const t of expect.screen_contains ?? []) if (!text.includes(t)) out.push(`expected the screen to show "${t}"; it shows ${shows()}`);
  for (const t of expect.screen_not_contains ?? []) if (text.includes(t)) out.push(`expected the screen not to show "${t}"`);
  if (expect.screen_order?.length) {
    const at = expect.screen_order.map((t) => text.indexOf(t));
    if (at.some((i) => i < 0)) out.push(`expected the screen to show ${expect.screen_order.map((t) => `"${t}"`).join(', ')}; it shows ${shows()}`);
    else if (at.some((i, k) => k > 0 && i < (at[k - 1] as number)))
      out.push(`expected ${expect.screen_order.map((t) => `"${t}"`).join(' before ')}; the screen has them in another order`);
  }
  if (expect.outcome === 'ok' && (obs.blocked || obs.status >= 400 || obs.status === 0))
    out.push(`expected the action to succeed; it was refused (${obs.status})`);
  if (expect.outcome === 'blocked' && !obs.blocked) out.push(`expected the action to be refused; it answered ${obs.status}`);
  if (expect.mail_to) {
    const to = emailOf(expect.mail_to, fixtures[expect.mail_to]);
    if (!obs.mail.some((m) => m.to === to))
      out.push(`expected mail to ${expect.mail_to} (${to}); ${obs.mail.length ? `mail went to ${obs.mail.map((m) => m.to).join(', ')}` : 'none was sent'}`);
  }
  if (expect.no_mail && obs.mail.length) out.push(`expected no mail; ${obs.mail.length} sent`);
  return out;
}
