/**
 * What a model answered when compiling examples/dogwalk, written down so the compiled files can be
 * reproduced, and tests run, without a model. Run `pnpm --filter @oodle/compile compile:dogwalk`
 * after changing them.
 */
import { scriptedModel } from '../src/index.ts';

const fixtures = { 'owner:ada': { name: 'Ada', address: '1 Elm St' }, 'walker:sam': { name: 'Sam' } };
/** The item being compiled: the prompt's last section, after the spec it shows for context. */
const subject = (prompt: string) => prompt.slice(prompt.lastIndexOf('## The '));
const book = (starts_at: string) => ({ as: 'owner:ada', do: 'owner.book_walk', input: { walker: 'walker:sam', starts_at, minutes: 30 } });

export const DOGWALK_ANSWERS = {
  'classify constraint': (ask: { prompt: string }) => ({
    check: 'build',
    reason: ask.prompt.includes('address') ? 'what each persona sees is observable in the simulation' : 'charges show on the screens the simulation reads',
  }),
  'compile journey first-booking': {
    scenario: {
      id: 'journey/first-booking',
      fixtures,
      steps: [
        {
          line: 0,
          prose: 'Ada opens the app, picks Sam for Tuesday 9:00, 30 minutes: she sees "Requested, $20"',
          at: '2026-11-02T08:00:00Z',
          ...book('2026-11-03T09:00:00Z'),
          expect: { screen_contains: ['Requested', '$20'] },
        },
        {
          line: 1,
          prose: 'Sam accepts: Ada sees "Accepted" and gets an email',
          as: 'walker:sam',
          do: 'walker.accept_walk',
          input: { walk: '$walk_1' },
          look: { as: 'owner:ada', screen: 'walk', params: { walk: '$walk_1' } },
          expect: { screen_contains: ['Accepted'], mail_to: 'owner:ada' },
        },
        {
          line: 2,
          prose: 'Ada cancels on Monday at 18:00: she sees "Cancelled, no charge"',
          at: '2026-11-02T18:00:00Z',
          as: 'owner:ada',
          do: 'owner.cancel_walk',
          input: { walk: '$walk_1' },
          expect: { screen_contains: ['Cancelled, no charge'] },
        },
      ],
    },
  },
  'compile check c_': (ask: { prompt: string }) =>
    subject(ask.prompt).includes("another owner's address")
      ? { check: { kind: 'never_shows_field', field: 'address', viewers: ['owner'], owners: ['owner'] } }
      : { check: { kind: 'never_matches', pattern: '(declined|cancelled)[^\\n]*charged \\$', viewers: ['owner'] } },
  'compile check d_': (ask: { prompt: string }) => {
    const id = /check\/(d_\w+)/.exec(ask.prompt)?.[1] ?? 'check';
    if (subject(ask.prompt).includes('soonest first')) {
      return {
        check: {
          kind: 'scenario',
          scenario: {
            id,
            fixtures,
            steps: [
              { at: '2026-11-02T08:00:00Z', ...book('2026-11-05T09:00:00Z') },
              book('2026-11-03T09:00:00Z'),
              book('2026-11-04T09:00:00Z'),
              { as: 'owner:ada', look: { screen: 'walks' }, expect: { screen_order: ['Tue 3 Nov', 'Wed 4 Nov', 'Thu 5 Nov'] } },
            ],
          },
        },
      };
    }
    if (subject(ask.prompt).includes('two decimals')) {
      return {
        check: {
          kind: 'scenario',
          scenario: { id, fixtures, steps: [{ at: '2026-11-02T08:00:00Z', ...book('2026-11-03T09:00:00Z'), expect: { screen_contains: ['$20.00'] } }] },
        },
      };
    }
    return {
      check: {
        kind: 'scenario',
        scenario: {
          id,
          fixtures,
          steps: [
            { at: '2026-11-02T08:00:00Z', ...book('2026-11-03T09:00:00Z') },
            { as: 'walker:sam', do: 'walker.decline_walk', input: { walk: '$walk_1' }, expect: { outcome: 'ok', screen_not_contains: ['reason', 'Reason'] } },
          ],
        },
      },
    };
  },
};

export const dogwalkModel = () => scriptedModel(DOGWALK_ANSWERS as never, 'recorded');
