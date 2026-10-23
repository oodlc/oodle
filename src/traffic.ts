/**
 * Stubs and request bodies from traffic (docs/decisions/0015). A capture already
 * holds what the APIs a service calls answered, and what its callers sent. This
 * turns both into proposals:
 *
 * - each outbound call the app's own `effects` rules name becomes a proposed stub
 *   in `proposed.stubs` of oodlc/config.yaml: the answer seen most (scrubbed), its
 *   status and the median latency. No run reads it until a person moves it into
 *   `defaults.given.stubs`. Every other status seen becomes a proposed condition;
 * - a body a caller sent becomes what `oodle propose --routes --from` probes with.
 *
 * Everything here was read through src/evidence.ts, so it is already scrubbed. It is
 * observed evidence (0014), and still only a proposal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseDocument } from 'yaml';
import { CatalogError, configFile, loadCatalog, loadConfig } from './catalog.ts';
import { OodleError } from './errors.ts';
import { ASSET, readEvidence, scopeFacts, type Call, type Evidence, type Scope } from './evidence.ts';
import { propose, type ProposeResult } from './propose.ts';
import { loadApp } from './runner.ts';
import type { Condition, EvidenceItem, Stub } from './types.ts';

export type ProposedStub = Stub & { evidence: EvidenceItem[] };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : undefined;
};
const ok = (status?: number) => status !== undefined && status >= 200 && status < 300;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The body a call answered with, as a stub result: `$status` when it wasn't a success, so the app sees that status. */
function resultOf(call: Call | undefined, status: number | undefined): unknown {
  const body = call?.response;
  if (ok(status) || status === undefined) return body ?? {};
  return { ...(plain(body) ? body : {}), $status: status };
}

export interface StubDrafts {
  stubs: Record<string, ProposedStub>;
  conditions: Condition[];
  /** Hosts called that no effects rule names: the service's own, other sites', or calls still to name. */
  unmatched: string[];
}

/** Proposed stubs and conditions from the outbound calls in some evidence, classified by the app's own rules. */
export function stubsFrom(evidence: Evidence[], effectKindOf: (url: URL, method: string) => string | undefined): StubDrafts {
  const byKind = new Map<string, { call: Call; from: Evidence }[]>();
  const unmatched = new Set<string>();
  for (const e of evidence) {
    for (const call of e.calls) {
      if (!call.host) continue;
      let kind: string | undefined;
      try {
        kind = effectKindOf(new URL(`https://${call.host}${call.path}`), call.method);
      } catch {
        kind = undefined;
      }
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), { call, from: e }]);
      else if (!ASSET.test(call.path)) unmatched.add(call.host);
    }
  }
  for (const seen of byKind.values()) for (const { call } of seen) unmatched.delete(call.host!);

  const stubs: Record<string, ProposedStub> = {};
  const conditions: Condition[] = [];
  for (const [kind, seen] of byKind) {
    const statuses = new Map<number, number>();
    for (const { call } of seen) if (call.status !== undefined) statuses.set(call.status, (statuses.get(call.status) ?? 0) + 1);
    const ranked = [...statuses].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([s]) => s);
    const main = ranked.find(ok) ?? ranked[0];
    const latency = median(seen.map(({ call }) => call.ms).filter((x): x is number => x !== undefined));
    const files = [...new Set(seen.map(({ from }) => from))];
    const where = files.map((e) => `${e.name} (${scopeFacts(e.scope)})`).join(' and ');
    const msOf = (status: number) => median(seen.filter(({ call }) => call.status === status).map(({ call }) => call.ms).filter((x): x is number => x !== undefined));
    const counts = ranked.map((s) => `${s} ×${statuses.get(s)}${msOf(s) !== undefined ? ` (median ${msOf(s)} ms)` : ''}`).join(', ');
    const bodyless = !seen.some(({ call }) => call.response !== undefined);
    const stubFor = (status: number | undefined): Stub => {
      const sameStatus = seen.filter(({ call }) => call.status === status);
      const timed = median(sameStatus.map(({ call }) => call.ms).filter((x): x is number => x !== undefined)) ?? latency;
      return { result: resultOf(sameStatus.find(({ call }) => call.response !== undefined)?.call, status), ...(timed !== undefined ? { latency_ms: timed } : {}) };
    };
    stubs[kind] = {
      ...stubFor(main),
      evidence: [{ text: `seen ${seen.length} time${seen.length === 1 ? '' : 's'} in ${where}${counts ? `: ${counts}` : latency !== undefined ? `: median ${latency} ms` : ''}${bodyless ? '; no response body to read, so the result is a placeholder' : ''}`, grade: 'observed' }],
    };
    for (const status of ranked.filter((s) => s !== main)) {
      conditions.push({
        id: `observed.${kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${status}`,
        statement: `${kind} answers ${status}, as seen ${statuses.get(status)} time${statuses.get(status) === 1 ? '' : 's'} in ${files.map((e) => e.name).join(', ')}`,
        given: { stubs: { [kind]: stubFor(status) } },
      });
    }
  }
  return { stubs, conditions, unmatched: [...unmatched].sort() };
}

export interface StubsResult extends ProposeResult {
  /** The kinds proposed under `proposed.stubs` in the config, with what was proposed. */
  stubs: { kind: string; stub: ProposedStub }[];
  /** Kinds already waiting in `proposed.stubs`, left as they are. */
  waiting: string[];
  unmatched: string[];
  evidence: { file: string; kind: Evidence['kind']; scope: Scope }[];
}

/**
 * Writes proposed stubs into `proposed.stubs` of oodlc/config.yaml, in place, keeping comments, and
 * proposes a condition for every other status seen. Adds, never changes: a kind already proposed, or a
 * condition id already taken, is left alone. `defaults` is never touched.
 */
export function proposeStubs(projectDir: string, files: string[], effectKindOf: ((url: URL, method: string) => string | undefined) | undefined): StubsResult {
  if (!files.length) throw new OodleError('usage', 'Stubs come from traffic: pass a capture with --from', { hint: 'For example `oodle propose --stubs --from egress.har`: a HAR recorded where the service calls out, or an OTLP trace export with client spans.' });
  if (!effectKindOf) throw new OodleError('evidence', 'The app names no effects rules to match calls against', { hint: 'Stubs from traffic need the app run through @oodlc/oodle/adapter or /next, with its outbound hosts under effects, e.g. { \'POST api.stripe.com/v1/charges\': \'payment.charge\' }.' });
  const evidence = files.map(readEvidence);
  const drafts = stubsFrom(evidence, effectKindOf);
  const config = loadConfig(projectDir);
  const where = configFile(projectDir)!.path;
  const text = readFileSync(where, 'utf8');
  const doc = parseDocument(text);
  const already = new Set(Object.keys(config.proposed?.stubs ?? {}));
  const fresh = Object.entries(drafts.stubs).filter(([kind]) => !already.has(kind));
  for (const [kind, stub] of fresh) doc.setIn(['proposed', 'stubs', kind], doc.createNode(stub));
  if (fresh.length) writeFileSync(where, doc.toString({ lineWidth: 0 }));
  try {
    loadConfig(projectDir);
  } catch (err) {
    writeFileSync(where, text);
    if (err instanceof CatalogError) throw new OodleError('proposal', 'The proposed stubs would break oodlc/config.yaml', { problems: err.problems });
    throw err;
  }
  const catalog = loadCatalog(projectDir, config);
  const conditions = drafts.conditions.filter((c) => !catalog.sources[`conditions:${c.id}`]);
  const added = conditions.length ? propose(projectDir, { conditions }) : { file: '', added: [], warnings: [] };
  return {
    ...added,
    file: relative(projectDir, where),
    stubs: fresh.map(([kind, stub]) => ({ kind, stub })),
    waiting: Object.keys(drafts.stubs).filter((k) => already.has(k)),
    unmatched: drafts.unmatched,
    evidence: evidence.map((e, i) => ({ file: files[i], kind: e.kind, scope: e.scope })),
  };
}

/** The app's own effects rules, loaded the way a run loads them. */
export async function effectRules(projectDir: string): Promise<((url: URL, method: string) => string | undefined) | undefined> {
  const config = loadConfig(projectDir);
  if (!config.app) throw new OodleError('no-app', 'There are no effects to stub: this project has no app', { hint: 'Point app in oodlc/config.yaml at a Node service; stubs stand in for the calls it makes.' });
  return (await loadApp(projectDir, config)).effectKindOf;
}
