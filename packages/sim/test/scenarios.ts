import type { Scenario } from '../src/index.ts';

export const FIXTURES = {
  'owner:ada': { name: 'Ada', address: '1 Elm St' },
  'owner:bea': { name: 'Bea', address: '9 Oak Ave' },
  'walker:sam': { name: 'Sam' },
};

/** The README's first-booking journey, compiled by hand. */
export const FIRST_BOOKING: Scenario = {
  id: 'journey/first-booking',
  fixtures: FIXTURES,
  steps: [
    {
      line: 0,
      at: '2026-11-02T08:00:00Z',
      as: 'owner:ada',
      do: 'owner.book_walk',
      input: { walker: 'walker:sam', starts_at: '2026-11-03T09:00:00Z', minutes: 30 },
      expect: { screen_contains: ['Requested', '$20'] },
    },
    {
      line: 1,
      as: 'walker:sam',
      do: 'walker.accept_walk',
      input: { walk: '$walk_1' },
      look: { as: 'owner:ada', screen: 'walk', params: { walk: '$walk_1' } },
      expect: { screen_contains: ['Accepted'], mail_to: 'owner:ada' },
    },
    {
      line: 2,
      at: '2026-11-02T18:00:00Z',
      as: 'owner:ada',
      do: 'owner.cancel_walk',
      input: { walk: '$walk_1' },
      expect: { screen_contains: ['Cancelled, no charge'] },
    },
  ],
};
