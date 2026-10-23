/**
 * `oodle ui`: the oodlc/ folder in a browser, for the people who look after it.
 * One local page that shows the catalog as a system (intents, the capabilities
 * that serve them, the outcomes that protect them) and puts what is waiting for
 * a person in one place: proposals, open questions, lint, failing outcomes.
 * See docs/decisions/0018.
 *
 * The files stay the source of truth. Every write goes through the same code as
 * `oodle interview` and lands in oodlc/ as an ordinary edit, comments and layout
 * kept, for git and review to see. Nothing is stored anywhere else.
 *
 * Who may do what follows 0006 and 0010: only a person approves or confirms.
 * The server takes "a person started me" from the same signal `oodle interview`
 * uses, a terminal on both ends; started without one, it still answers questions,
 * with an agent's rights, and refuses to approve anything.
 *
 * It listens on 127.0.0.1 only, and every API call needs the token printed at
 * start. A request whose Host or Origin isn't this server is refused, so a web
 * page elsewhere can't reach the catalog through the browser.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { isMap, isSeq, parseDocument, stringify, type YAMLMap, type YAMLSeq } from 'yaml';
import { CatalogError, FOLDER, loadCatalog, loadConfig } from './catalog.ts';
import { lint, saysNothing } from './lint.ts';
import { applyAnswers, questions, type Answer } from './interview.ts';
import { changeBrief, originOf } from './changes.ts';
import { oodleJson } from './mcp.ts';
import { OodleError } from './errors.ts';
import { display } from './project.ts';

const PAGE = new URL('./ui.html', import.meta.url);

/** The sections whose entries carry `status: proposed`, and so can wait for a person. */
export const APPROVABLE = ['intents', 'actors', 'capabilities', 'experiences', 'terms', 'outcomes', 'constraints'] as const;
type Approvable = (typeof APPROVABLE)[number];

export interface UiOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Started by a person at a terminal: may approve and confirm. Otherwise an agent's rights. */
  byPerson: boolean;
  version: string;
  /** For tests. Default: a fresh random token. */
  token?: string;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** What the page shows without running anything: the catalog as the files say it. */
export function uiState(projectDir: string, byPerson: boolean, version: string) {
  const base = { project: basename(projectDir), dir: display(projectDir), oodle: version, byPerson };
  let config, catalog;
  try {
    config = loadConfig(projectDir);
    catalog = loadCatalog(projectDir, config);
  } catch (err) {
    // A half-edited file is normal while someone works on the catalog: show it, don't fall over.
    if (err instanceof CatalogError || err instanceof OodleError) return { ok: false, ...base, error: { message: err.message, problems: (err as CatalogError).problems ?? [] } };
    throw err;
  }
  const proposals = APPROVABLE.flatMap((section) =>
    (catalog[section] as { id: string; status?: string }[]).filter((x) => x.status === 'proposed').map((entry) => ({ section, id: entry.id, file: catalog.sources[`${section}:${entry.id}`], entry })),
  );
  return {
    ok: true,
    ...base,
    hasApp: !!config.app,
    catalog: { ...catalog, sources: undefined },
    sources: catalog.sources,
    // Each entry as it reads in its file, for the page to show without a YAML parser of its own.
    yaml: Object.fromEntries((['outcomes', 'behaviors', 'constraints', ...APPROVABLE] as const).flatMap((section) => (catalog[section] as { id: string }[]).map((x) => [`${section}:${x.id}`, stringify(x, { lineWidth: 0 })]))),
    lint: lint(catalog, config),
    questions: questions(catalog),
    proposals,
    stubs: Object.entries(config.proposed?.stubs ?? {}).map(([kind, stub]) => ({ kind, stub })),
    changes: catalog.changes.map((c) => ({ ...c, file: catalog.sources[`changes:${c.id}`], origin: originOf(projectDir, catalog.sources[`changes:${c.id}`]) })),
  };
}

/**
 * Approves a proposal: removes its `status: proposed` line, and sets a sharper
 * statement first when one is given. A person's call only. The catalog must lint
 * no worse than before, or the file is put back as it was.
 */
export function approve(projectDir: string, section: string, id: string, opts: { byPerson: boolean; statement?: string }): { changed: string[] } {
  if (!(APPROVABLE as readonly string[]).includes(section)) throw new OodleError('usage', `Nothing in ${section} can be approved`, { hint: `Proposals live in ${APPROVABLE.join(', ')}.` });
  if (!opts.byPerson) {
    throw new OodleError('approved', 'Approving is a person\'s call', { hint: 'Start `oodle ui` from a terminal to approve here, or delete the entry\'s "status: proposed" line yourself.' });
  }
  const current = (loadCatalog(projectDir, loadConfig(projectDir))[section as Approvable] as { id: string; statement: string }[]).find((x) => x.id === id);
  const said = opts.statement?.trim() || current?.statement || '';
  // An approved entry that says nothing is a promise nobody made.
  const empty = current && saysNothing(said);
  if (empty) throw new OodleError('answer', `${id} doesn't say anything yet`, { hint: `Say what it is first (${empty}), then approve it.` });
  // Capabilities, experiences and terms confirm the way the interview does.
  if (section === 'capabilities' || section === 'experiences' || section === 'terms') {
    const kind = section === 'capabilities' ? 'capability' : section === 'experiences' ? 'experience' : 'term';
    return applyAnswers(projectDir, [{ kind, id, confirm: true, ...(opts.statement?.trim() ? { statement: opts.statement } : {}) } as Answer], { byPerson: true });
  }
  const config = loadConfig(projectDir);
  const before = loadCatalog(projectDir, config);
  const rel = before.sources[`${section}:${id}`];
  const entry = (before[section as Approvable] as { id: string; status?: string }[]).find((x) => x.id === id);
  if (!rel || !entry) throw new OodleError('no-match', `No ${section.replace(/s$/, '')} "${id}"`, { hint: 'The proposals are listed on the Proposals page.' });
  if (entry.status !== 'proposed') return { changed: [] };
  const path = join(projectDir, rel);
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text);
  const seq = doc.get(section);
  const item = isSeq(seq) ? (seq as YAMLSeq).items.find((i): i is YAMLMap => isMap(i) && (i as YAMLMap).get('id') === id) : undefined;
  if (!item) throw new OodleError('no-match', `${id} is not where the catalog says, in ${rel}`, { hint: 'Reload the page: the file may have just changed.' });
  const what: string[] = [];
  if (opts.statement?.trim()) (item.set('statement', doc.createNode(opts.statement.trim())), what.push('statement'));
  item.delete('status');
  what.push('approved');
  const lintBefore = new Set(lint(before, config).errors);
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  try {
    const fresh = lint(loadCatalog(projectDir, config), config).errors.filter((e) => !lintBefore.has(e));
    if (fresh.length) throw new OodleError('answer', `Approving ${id} leaves the catalog with errors`, { problems: fresh, hint: 'Sharpen what lint names, then approve again.' });
  } catch (err) {
    writeFileSync(path, text);
    if (err instanceof CatalogError) throw new OodleError('answer', `Approving ${id} would break the catalog`, { problems: err.problems });
    throw err;
  }
  return { changed: [`${section.replace(/ies$/, 'y').replace(/s$/, '')} ${id}: ${what.join(', ')}`] };
}

/** The last run, in two halves: the per-condition observations, and the system map built from them. */
interface RunState {
  at: string;
  ms: number;
  run: any;
  map: any;
  /** changedAt when the run started. */
  seen: number;
}

export async function serveUi(projectDir: string, opts: UiOptions): Promise<UiServer> {
  const token = opts.token ?? randomBytes(18).toString('base64url');
  let last: RunState | null = null;
  /** When the files last changed, so the page can say a run is out of date. */
  let changedAt = 0;
  let running: Promise<RunState> | null = null;
  const listeners = new Set<ServerResponse>();

  const runNow = () =>
    (running ??= (async () => {
      const started = Date.now();
      // Edits made while it runs may or may not be in it: call them unseen.
      const seen = changedAt;
      // In child processes, as the MCP server does, so the app is imported fresh each time.
      const [run, map] = await Promise.all([oodleJson(['run', projectDir], projectDir), oodleJson(['explain', projectDir], projectDir)]);
      last = { at: new Date().toISOString(), ms: Date.now() - started, run: run.doc, map: map.doc, seen };
      broadcast('run');
      return last;
    })().finally(() => (running = null)));

  const broadcast = (event: string) => {
    for (const res of listeners) res.write(`event: ${event}\ndata: {}\n\n`);
  };

  // Edits made in an editor, by git or by an agent show up without a reload.
  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | undefined;
  try {
    watcher = watch(join(projectDir, FOLDER), { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => ((changedAt = Date.now()), broadcast('catalog')), 150);
    });
  } catch {
    // No recursive watching on this platform: the page still has its refresh button.
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const e = err as OodleError;
      send(res, e instanceof OodleError ? (e.code === 'approved' ? 403 : e.code === 'no-match' ? 404 : 400) : 500, {
        ok: false,
        error: { code: e.code ?? 'internal', message: e.message, ...(e.hint ? { hint: e.hint } : {}), problems: e.problems ?? [] },
      });
    }
  });

  const port = await new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => done((server.address() as { port: number }).port));
  });
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // A page on another site can point a name at 127.0.0.1; it can't make the browser send our Host or Origin.
    const host = req.headers.host ?? '';
    if (!origins.has(`http://${host}`)) return send(res, 421, { ok: false, error: { code: 'host', message: `Not this server: ${host}` } });
    if (req.headers.origin && !origins.has(req.headers.origin)) return send(res, 403, { ok: false, error: { code: 'origin', message: 'Cross-origin requests are refused' } });

    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      return res.end(readFileSync(PAGE));
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: { code: 'no-match', message: 'Not found' } });
    const given = String(req.headers['x-oodle-token'] ?? url.searchParams.get('token') ?? '');
    if (!sameToken(given, token)) return send(res, 401, { ok: false, error: { code: 'token', message: 'Missing or wrong token', hint: 'Open the link `oodle ui` printed.' } });

    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') return send(res, 200, { ...uiState(projectDir, opts.byPerson, opts.version), run: last, running: !!running, stale: !!last && changedAt > last.seen });
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': oodle\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (route === 'POST /api/run') {
      broadcast('running');
      return send(res, 200, { ok: true, ...(await runNow()) });
    }
    if (route === 'POST /api/answer') {
      const body = await readJson(req);
      const answers: Answer[] = Array.isArray(body.answers) ? body.answers : [body.answer];
      return send(res, 200, { ok: true, ...applyAnswers(projectDir, answers, { byPerson: opts.byPerson }) });
    }
    if (route === 'POST /api/approve') {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...approve(projectDir, String(body.section), String(body.id), { byPerson: opts.byPerson, statement: body.statement }) });
    }
    const brief = /^GET \/api\/changes\/([^/]+)\/brief$/.exec(route);
    if (brief) return send(res, 200, { ok: true, id: decodeURIComponent(brief[1]), brief: changeBrief(projectDir, decodeURIComponent(brief[1])) });
    return send(res, 404, { ok: false, error: { code: 'no-match', message: `No ${route}` } });
  }

  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((done) => {
        watcher?.close();
        clearTimeout(debounce);
        for (const res of listeners) res.end();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new OodleError('usage', 'Send JSON', { hint: 'content-type: application/json' });
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw new OodleError('usage', 'That request is too large');
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new OodleError('usage', 'That request is not valid JSON');
  }
}

