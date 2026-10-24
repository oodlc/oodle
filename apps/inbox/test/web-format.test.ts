import { describe, expect, it } from 'vitest';
import type { GapRecord } from '../src/shared/protocol.ts';
import {
  age,
  answerInWords,
  decisionEffect,
  describeChange,
  groupGaps,
  matchRoute,
  openRaised,
  rulesOutLabel,
  sampleLines,
  scenarioInWords,
  who,
} from '../src/web/lib/format.ts';
import { CANCEL_FEE, gapById, WORDING } from './helpers.ts';

describe('scenarios in plain words', () => {
  it('reads explore and journey ids', () => {
    expect(scenarioInWords({ scenario: 'explore/collections/walks-7' })).toBe('Someone looks at a list of 7 walks.');
    expect(scenarioInWords({ scenario: 'explore/collections/walks-1' })).toBe('Someone looks at a list of 1 walk.');
    expect(scenarioInWords({ scenario: 'explore/collections/walks-0' })).toBe('Someone looks at an empty list of walks.');
    expect(scenarioInWords({ scenario: 'explore/permissions/walker-cancel_walk' })).toBe('Checking who may do what: walker cancel walk.');
    expect(scenarioInWords({ scenario: 'journey/first-booking#2' })).toBe('In the journey "first booking", step 2.');
    expect(scenarioInWords({ scenario: 'custom/thing', scenario_text: 'Ada books twice.' })).toBe('Ada books twice.');
  });
});

describe('samples and answers', () => {
  it('turns sample values into lines', () => {
    expect(sampleLines(['Tue 9:00', 3, null, { price: '$20', status: 'requested' }])).toEqual(['Tue 9:00', '3', '(empty)', 'Price: $20 · Status: requested']);
  });

  it('describes answers with the gap’s own labels', () => {
    const gap = gapById(WORDING).body;
    expect(answerInWords({ option: 'a' }, gap)).toBe('Requested, $20');
    expect(answerInWords({ text: 'Show the price', target: 'domain_rule' }, gap)).toBe('Domain rule: "Show the price"');
    expect(answerInWords({ dont_care: true }, gap)).toBe('Either is fine');
    expect(answerInWords({ dismiss: true }, gap)).toBe('Not a real difference');
    expect(who('person:ada@x.test')).toBe('ada@x.test');
    expect(who('agent:claude@local')).toBe('an agent (claude@local)');
  });

  it('says which decision an option adds and which it replaces', () => {
    const gap = gapById(WORDING).body;
    expect(decisionEffect(gap, 'a')).toEqual({ adds: 'After booking, the owner sees "Requested, <price>"' });
    expect(decisionEffect(gap, 'b')).toEqual({
      adds: 'After booking, the owner sees the walker, the time and the price',
      replaces: "Prices are shown in the owner's currency, two decimals",
    });
    // Against a standing answer that pinned another decision.
    expect(decisionEffect(gap, 'a', { option: 'b' }).replaces).toBe('After booking, the owner sees the walker, the time and the price');
    expect(decisionEffect(gap, 'dont_care')).toEqual({});
  });
});

describe('intent changes', () => {
  it('renders known ops as before and after', () => {
    expect(describeChange({ op: 'replace_rule', entity: 'walk', from: 'free until 2h', to: 'free until 2h; then 50%' })).toEqual({
      title: 'Change a rule about walk',
      before: 'free until 2h',
      after: 'free until 2h; then 50%',
      details: [],
    });
    expect(describeChange({ op: 'add_constraint', text: 'No one sees another owner’s address' }).after).toBe('No one sees another owner’s address');
    expect(describeChange({ op: 'add_step', journey: 'late-cancellation', step: 'Ada cancels at 8:00', after: 'Sam accepts' })).toMatchObject({
      title: 'New step in journey "late-cancellation"',
      after: 'Ada cancels at 8:00',
      details: [['After', 'Sam accepts']],
    });
  });

  it('falls back to a readable field list for unknown ops', () => {
    expect(describeChange({ op: 'rename_entity', from: 'walk', to: 'outing', note: 'everywhere' })).toEqual({
      title: 'Rename entity',
      before: 'walk',
      after: 'outing',
      details: [['Note', 'everywhere']],
    });
    expect(rulesOutLabel('new_outbound_hosts')).toBe('No new outside services');
    expect(rulesOutLabel('new_tables')).toBe('Nothing new of this kind: new tables');
  });
});

describe('inbox grouping and routes', () => {
  const rec = (id: string, about: string[], intent: string | null, created_at: string) =>
    ({ id, intent_id: intent, created_at, status: 'open', body: { about } }) as unknown as GapRecord;

  it('groups by intent (none first), then entity, oldest first', () => {
    const groups = groupGaps([
      rec('g3', ['entity:walk'], CANCEL_FEE, '2026-11-03'),
      rec('g2', ['entity:walker'], null, '2026-11-02'),
      rec('g1', ['entity:walk'], null, '2026-11-04'),
      rec('g0', ['entity:walk'], null, '2026-11-01'),
      rec('g4', ['screen:home'], null, '2026-11-01'),
    ]);
    expect(groups.map((g) => [g.intent, g.entities.map((e) => [e.entity, e.gaps.map((x) => x.id)])])).toEqual([
      [
        null,
        [
          ['walk', ['g0', 'g1']],
          ['walker', ['g2']],
          [null, ['g4']],
        ],
      ],
      [CANCEL_FEE, [['walk', ['g3']]]],
    ]);
    expect(openRaised([{ status: 'open' }, { status: 'answered' }, { status: 'open' }])).toBe(2);
  });

  it('matches client routes', () => {
    expect(matchRoute('/app/')).toEqual({ screen: 'inbox' });
    expect(matchRoute('/app')).toEqual({ screen: 'inbox' });
    expect(matchRoute('/app/p/dogwalk/gaps/g_1')).toEqual({ screen: 'gap', project: 'dogwalk', id: 'g_1' });
    expect(matchRoute('/app/p/dogwalk/intents/i_cancel_fee')).toEqual({ screen: 'intent', project: 'dogwalk', id: 'i_cancel_fee' });
    expect(matchRoute('/app/p/dogwalk/activity')).toEqual({ screen: 'activity', project: 'dogwalk' });
    expect(matchRoute('/app/p/dogwalk/gaps')).toEqual({ screen: 'not_found' });
  });

  it('gives short ages', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(age('2026-11-02T11:59:30Z', now)).toBe('just now');
    expect(age('2026-11-02T11:48:00Z', now)).toBe('12 min');
    expect(age('2026-11-02T09:00:00Z', now)).toBe('3 h');
    expect(age('2026-10-28T12:00:00Z', now)).toBe('5 d');
  });
});

describe('declared-tier effects', () => {
  it('says what a permission or rule option writes', () => {
    const gap = {
      options: [
        { id: 'a', label: 'Refuse it', becomes: { cannot: { persona: 'owner', text: "cancel another owner's walks" } } },
        { id: 'b', label: 'Allow it', becomes: { constraint: 'Any owner can cancel any walk' } },
        { id: 'c', label: 'A rule', becomes: { rule: { entity: 'walk', text: 'Only the owner cancels' } } },
      ],
    };
    expect(decisionEffect(gap, 'a').declared).toBe("Says an owner cannot cancel another owner's walks");
    expect(decisionEffect(gap, 'b').declared).toBe('Adds the constraint “Any owner can cancel any walk”');
    expect(decisionEffect(gap, 'c').declared).toBe('Adds a rule about walk: “Only the owner cancels”');
  });
});
