import type { AnswerBody, Evidence, GapFile, GapKind, GapRecord, GapStatus, IntentChange, RuleTarget } from '../../shared/protocol.ts';

/**
 * Pure helpers that turn gap and intent files into words for people. No DOM, so the tests
 * run them in the Worker pool with everything else.
 */

const KINDS: Record<GapKind, string> = {
  sort_order: 'Order',
  format: 'Format',
  permission: 'Who may do what',
  rule: 'Rule',
  extra_element: 'Something extra on screen',
  wording: 'Wording',
  pagination: 'Paging',
  decision_moved: 'A pinned decision moved',
  other: 'Other',
};
export const kindLabel = (kind: string) => KINDS[kind as GapKind] ?? humanize(kind);

const STATUSES: Record<GapStatus, string> = {
  open: 'Open',
  answered: 'Answered, waiting to be applied',
  dismissed: 'Not a real difference',
  applied: 'Applied to the spec',
  superseded: 'No longer raised',
};
export const statusLabel = (s: string) => STATUSES[s as GapStatus] ?? humanize(s);

const TARGETS: Record<RuleTarget, string> = { decision: 'Decision', domain_rule: 'Domain rule', constraint: 'Constraint' };
export const targetLabel = (t: string) => TARGETS[t as RuleTarget] ?? humanize(t);

/** `new_outbound_hosts` → "New outbound hosts". */
export function humanize(id: string): string {
  const words = id
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const RULES_OUT: Record<string, string> = {
  new_dependencies: 'No new dependencies',
  new_outbound_hosts: 'No new outside services',
  new_routes: 'No new pages or endpoints',
};
export const rulesOutLabel = (id: string) => RULES_OUT[id] ?? `Nothing new of this kind: ${humanize(id).toLowerCase()}`;

/** `person:ada@x.test` → `ada@x.test`; `agent:claude@local` → `an agent (claude@local)`. */
export function who(by: string | null | undefined): string {
  if (!by) return 'nobody';
  if (by.startsWith('person:')) return by.slice(7);
  if (by.startsWith('agent:')) return `an agent (${by.slice(6)})`;
  if (by.startsWith('token:')) return 'the CLI';
  return by;
}

const plural = (word: string, n: number) => (n === 1 ? word : word.endsWith('s') ? word : `${word}s`);

/**
 * The scenario in plain words. Uses `scenario_text` when the CLI wrote one; otherwise reads the
 * id's shape (`explore/<family>/<rest>` or `journey/<id>#<step>`).
 */
export function scenarioInWords(e: Pick<Evidence, 'scenario' | 'scenario_text'>): string {
  if (e.scenario_text) return e.scenario_text;
  const [head, family, ...rest] = e.scenario.split('/');
  if (head === 'journey' && family) {
    const [id, step] = family.split('#');
    return `In the journey "${humanize(id ?? family).toLowerCase()}"${step ? `, step ${step}` : ''}.`;
  }
  const tail = rest.join('/');
  if (head === 'explore') {
    if (family === 'collections') {
      const m = /^(.+?)-(\d+)$/.exec(tail);
      if (m?.[1] && m[2]) {
        const n = Number(m[2]);
        const thing = plural(humanize(m[1]).toLowerCase().replace(/s$/, ''), n);
        return n === 0 ? `Someone looks at an empty list of ${plural(thing, 2)}.` : `Someone looks at a list of ${n} ${thing}.`;
      }
      return `Someone looks at a list: ${humanize(tail).toLowerCase()}.`;
    }
    if (family === 'permissions') return `Checking who may do what: ${humanize(tail).toLowerCase()}.`;
    if (family === 'states') return `Moving something from one state to another: ${humanize(tail).toLowerCase()}.`;
    if (family === 'rules') return `Right at the edge of a rule: ${humanize(tail).toLowerCase()}.`;
    if (family === 'fields') return `An unusual value in a field: ${humanize(tail).toLowerCase()}.`;
  }
  return `${humanize(e.scenario.replace(/\//g, ' '))}.`;
}

/** Sample values as a person would read them, one line each. */
export function sampleLines(sample: unknown[] | undefined): string[] {
  return (sample ?? []).map((v) => {
    if (v === null || v === undefined) return '(empty)';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => sampleLines([x])[0]).join(', ');
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${humanize(k)}: ${sampleLines([x])[0]}`)
      .join(' · ');
  });
}

/** Relative age for lists: "just now", "12 min", "3 h", "5 d". */
export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** An answer in words, using the gap's own option labels. */
export function answerInWords(a: AnswerBody, gap: Pick<GapFile, 'options'>): string {
  if ('option' in a) return gap.options.find((o) => o.id === a.option)?.label ?? `Option ${a.option}`;
  if ('text' in a) return `${targetLabel(a.target)}: "${a.text}"`;
  if ('dont_care' in a) return 'Either is fine';
  return 'Not a real difference';
}

export type DecisionEffect = { adds?: string; replaces?: string; declared?: string };

/**
 * What choosing an option would do to decisions.yaml: the decision it adds and, if any, the one
 * it replaces. Replacement comes from `becomes.replaces` when the CLI says so, or from the
 * answer that stands now when it pointed at a different decision.
 */
export function decisionEffect(gap: Pick<GapFile, 'options'>, optionId: string, standing?: AnswerBody | null): DecisionEffect {
  const option = gap.options.find((o) => o.id === optionId);
  const adds = option?.becomes?.decision;
  const prev = standing && 'option' in standing ? gap.options.find((o) => o.id === standing.option)?.becomes?.decision : undefined;
  const replaces = option?.becomes?.replaces ?? (prev && prev !== adds ? prev : undefined);
  const b = option?.becomes;
  const declared = b?.constraint
    ? `Adds the constraint “${b.constraint}”`
    : b?.rule
      ? `Adds a rule about ${b.rule.entity}: “${b.rule.text}”`
      : b?.cannot
        ? `Says ${/^[aeiou]/i.test(b.cannot.persona) ? 'an' : 'a'} ${b.cannot.persona} cannot ${b.cannot.text}`
        : undefined;
  return { ...(adds ? { adds } : {}), ...(replaces ? { replaces } : {}), ...(declared ? { declared } : {}) };
}

export type ChangeView = { title: string; before?: string; after?: string; details: [string, string][] };

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** One declared-tier change as a readable before/after. Unknown ops get a generic field list. */
export function describeChange(change: IntentChange): ChangeView {
  const c = change as Record<string, unknown>;
  const entity = typeof c.entity === 'string' ? ` ${c.entity}` : '';
  const journey = typeof c.journey === 'string' ? ` "${c.journey}"` : '';
  switch (c.op) {
    case 'replace_rule':
      return { title: `Change a rule about${entity}`, before: str(c.from), after: str(c.to), details: [] };
    case 'add_rule':
      return { title: `New rule about${entity}`, after: str(c.rule), details: [] };
    case 'remove_rule':
      return { title: `Remove a rule about${entity}`, before: str(c.rule), details: [] };
    case 'add_constraint':
      return { title: 'New constraint', after: str(c.text), details: [] };
    case 'remove_constraint':
      return { title: 'Remove a constraint', before: str(c.text), details: [] };
    case 'replace_constraint':
      return { title: 'Change a constraint', before: str(c.from), after: str(c.to), details: [] };
    case 'add_journey':
      return {
        title: `New journey${journey}${typeof c.persona === 'string' ? ` for ${c.persona}` : ''}`,
        after: Array.isArray(c.steps) ? c.steps.map(str).join('\n') : undefined,
        details: [],
      };
    case 'add_step':
      return {
        title: `New step in journey${journey}`,
        after: str(c.step),
        details: typeof c.after === 'string' ? [['After', c.after]] : [],
      };
    case 'replace_step':
      return { title: `Change a step in journey${journey}`, before: str(c.from), after: str(c.to), details: [] };
    case 'add_persona_capability':
      return { title: `${typeof c.persona === 'string' ? humanize(c.persona) : 'A persona'} can do something new`, after: str(c.can), details: [] };
  }
  const details = Object.entries(c)
    .filter(([k]) => !['op', 'from', 'to'].includes(k))
    .map(([k, v]): [string, string] => [humanize(k), str(v)]);
  return {
    title: humanize(str(c.op)),
    ...(c.from !== undefined ? { before: str(c.from) } : {}),
    ...(c.to !== undefined ? { after: str(c.to) } : {}),
    details,
  };
}

/** The entity a gap is about (`entity:walk` → `walk`), for grouping. */
export const entityOf = (about: string[] | undefined) => about?.find((a) => a.startsWith('entity:'))?.slice(7) ?? null;

export type InboxGroup = { intent: string | null; entities: { entity: string | null; gaps: GapRecord[] }[] };

/** Inbox grouping within a project (10.5): by intent (gaps outside any intent first), then by entity. Oldest first inside. */
export function groupGaps(gaps: GapRecord[]): InboxGroup[] {
  const byIntent = new Map<string | null, Map<string | null, GapRecord[]>>();
  const sorted = [...gaps].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const g of sorted) {
    const entities = byIntent.get(g.intent_id) ?? new Map<string | null, GapRecord[]>();
    byIntent.set(g.intent_id, entities);
    const entity = entityOf(g.body.about);
    entities.set(entity, [...(entities.get(entity) ?? []), g]);
  }
  const order = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b));
  return [...byIntent.entries()]
    .sort(([a], [b]) => order(a, b))
    .map(([intent, entities]) => ({
      intent,
      entities: [...entities.entries()]
        .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
        .map(([entity, gs]) => ({ entity, gaps: gs })),
    }));
}

/** Approve stays disabled while any gap the intent raised is open. */
export const openRaised = (gaps: Pick<GapRecord, 'status'>[]) => gaps.filter((g) => g.status === 'open').length;

export type Route =
  | { screen: 'inbox' }
  | { screen: 'gap'; project: string; id: string }
  | { screen: 'intent'; project: string; id: string }
  | { screen: 'activity'; project: string }
  | { screen: 'settings'; project: string }
  | { screen: 'not_found' };

/** Client-side routes under /app. */
export function matchRoute(pathname: string): Route {
  const parts = pathname
    .replace(/^\/app\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  if (parts.length === 0) return { screen: 'inbox' };
  const [p, project, kind, id] = parts;
  if (p !== 'p' || !project) return { screen: 'not_found' };
  if (kind === 'gaps' && id && parts.length === 4) return { screen: 'gap', project, id };
  if (kind === 'intents' && id && parts.length === 4) return { screen: 'intent', project, id };
  if (kind === 'activity' && parts.length === 3) return { screen: 'activity', project };
  if (kind === 'settings' && parts.length === 3) return { screen: 'settings', project };
  return { screen: 'not_found' };
}

export const paths = {
  inbox: () => '/app/',
  gap: (project: string, id: string) => `/app/p/${encodeURIComponent(project)}/gaps/${encodeURIComponent(id)}`,
  intent: (project: string, id: string) => `/app/p/${encodeURIComponent(project)}/intents/${encodeURIComponent(id)}`,
  activity: (project: string) => `/app/p/${encodeURIComponent(project)}/activity`,
  settings: (project: string) => `/app/p/${encodeURIComponent(project)}/settings`,
};

/** An event's data as a short line for the activity log. */
export function eventSummary(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}
