import type { Driver, Session } from '@oodle/runtime';

const form = (data: Record<string, unknown>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])).toString(),
  redirect: 'manual' as const,
});

/** Posts a form and lands where the app sends the user: the redirect, or the page it answered with. */
async function submit(s: Session, path: string, data: Record<string, unknown> = {}) {
  const res = await s.fetch(path, form(data));
  const location = res.headers.get('location') ?? undefined;
  await res.arrayBuffer();
  return location;
}

const walkPath = (id: unknown) => `/walks/${String(id)}`;

/** Where a form post lands: the redirect when it succeeded, otherwise the page the app answered with. */
const landed = (location: string | undefined) => (location ? { screen: location } : {});

export const driver: Driver = {
  actions: {
    'owner.book_walk': async (s, input) => {
      const to = await submit(s, '/walks', { walker: input.walker, starts_at: input.starts_at, minutes: input.minutes });
      const id = to?.split('/').pop();
      return id ? { screen: to, created: [{ kind: 'walk', id }] } : {};
    },
    'owner.cancel_walk': async (s, input) => landed(await submit(s, `${walkPath(input.walk)}/cancel`)),
    'owner.rate_walker': async (s, input) => landed(await submit(s, `${walkPath(input.walk)}/rate`, { stars: input.stars })),
    'walker.set_availability': async (s, input) => landed(await submit(s, '/availability', { from: input.from, to: input.to })),
    'walker.accept_walk': async (s, input) => landed(await submit(s, `${walkPath(input.walk)}/accept`)),
    'walker.decline_walk': async (s, input) => landed(await submit(s, `${walkPath(input.walk)}/decline`)),
    'walker.see_earnings': async (s) => {
      const res = await s.fetch('/earnings');
      await res.arrayBuffer();
      return { screen: '/earnings' };
    },
  },
  screens: {
    home: () => '/',
    walks: () => '/',
    walk: (_s, p) => walkPath(p.walk),
    earnings: () => '/earnings',
    availability: () => '/availability',
  },
};
