/**
 * Writes sections back to the files they came from, changing as little text as it can: an entry
 * that didn't change keeps its exact bytes (alignment, quoting, inline comments), the comments and
 * blank lines between entries stay where they were, and the rest of the file is not touched. Only
 * new and changed entries are rendered. An entry is matched to the one it replaces by id
 * (decisions) or text (constraints).
 *
 * Decisions are always written in long form, so a bare string the generator or a person wrote
 * gets its id the first time the file is written. A constraint stays a bare string until it has
 * a `check`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isScalar, isSeq, type Node, parseDocument, type Scalar, type YAMLSeq } from 'yaml';
import { decisionId, stableStringify } from './hash.ts';
import { type LoadedSpec, SINGLE_FILE, specDir } from './load.ts';
import type { Constraint, Decision } from './schema.ts';

const DECISION_KEYS = ['id', 'text', 'about', 'source', 'status', 'created_by_build', 'answered_by', 'from_gap'] as const;
const RENDER = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Writes the decisions, in this order. `comments` (by id) go above entries that are new. Returns the file written. */
export function writeDecisions(loaded: LoadedSpec, decisions: Decision[], comments: Record<string, string> = {}): string {
  const path = writeList(loaded, 'decisions', decisions, {
    comments,
    keyOf: (node) => (isScalar(node) ? decisionId(String(node.value)) : isMap(node) ? String(node.get('id')) : undefined),
    keyOfItem: (d) => d.id,
    form: (d) => Object.fromEntries(DECISION_KEYS.filter((k) => d[k] !== undefined && !(k === 'about' && d.about.length === 0)).map((k) => [k, d[k]])),
  });
  loaded.spec.decisions = decisions;
  return path;
}

/** Writes the constraints, in this order. `comments` (by text) go above entries that are new. Returns the file written. */
export function writeConstraints(loaded: LoadedSpec, constraints: Constraint[], comments: Record<string, string> = {}): string {
  const path = writeList(loaded, 'constraints', constraints, {
    comments,
    keyOf: (node) => (isScalar(node) ? String(node.value) : isMap(node) ? String(node.get('text')) : undefined),
    keyOfItem: (c) => c.text,
    form: (c) => (c.check ? { text: c.text, check: c.check } : c.text),
  });
  loaded.spec.constraints = constraints;
  return path;
}

interface ListShape<T> {
  /** The key of an entry already in the file. */
  keyOf: (node: unknown) => string | undefined;
  keyOfItem: (item: T) => string;
  /** What the entry looks like in YAML: a string, or a map in key order. */
  form: (item: T) => string | Record<string, unknown>;
  /** A comment above a new entry, by key: who added it, and why. */
  comments?: Record<string, string>;
}

type Section = 'decisions' | 'constraints';

function writeList<T>(loaded: LoadedSpec, section: Section, items: T[], shape: ListShape<T>): string {
  const source = sourceOf(loaded, section);
  const file = loaded.files.get(source.path);
  const doc = file?.doc;
  const text = file?.text ?? '';
  const seq = doc ? seqOf(doc, section, source.keyed) : undefined;

  let out: string;
  if (seq && !seq.flow && seq.items.length && seq.range) {
    out = splice(text, seq, items, shape);
  } else if (doc && seq) {
    // An empty or flow-style list: rewrite the list, rendered.
    seq.flow = false;
    seq.items = items.map((item) => fromForm(shape.form(item)));
    out = doc.toString(RENDER);
  } else if (doc && source.keyed) {
    const block = new Document({ [section]: items.map((item) => shape.form(item)) }).toString(RENDER);
    out = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text.trim() ? '\n' : ''}${block}`;
  } else {
    out = render(items.map((item) => shape.form(item)));
  }

  return save(loaded, source.path, out);
}

/**
 * The list rewritten in place. Each existing entry is a prefix (the comments and blank lines
 * between it and the entry before) and a body (its `-` line through its end). Unchanged entries
 * keep both; changed ones keep their prefix and get a new body; new ones are rendered.
 */
function splice<T>(text: string, seq: YAMLSeq, items: T[], shape: ListShape<T>): string {
  const parts: { node: Node; lineStart: number; bodyEnd: number; prefix: string; body: string }[] = [];
  for (const node of seq.items as Node[]) {
    const [start = 0, valueEnd = 0, end = 0] = node.range ?? [];
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const bodyEnd = text[end - 1] === '\n' ? end : endOfLine(text, Math.max(valueEnd - 1, start));
    const prevEnd = parts[parts.length - 1]?.bodyEnd ?? lineStart;
    parts.push({ node, lineStart, bodyEnd, prefix: text.slice(prevEnd, lineStart), body: text.slice(lineStart, bodyEnd) });
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return text;
  const indent = text.slice(first.lineStart).match(/^ */)?.[0] ?? '';

  const byKey = new Map<string, (typeof parts)[number]>();
  for (const p of parts) {
    const key = shape.keyOf(p.node);
    if (key !== undefined && !byKey.has(key)) byKey.set(key, p);
  }
  const written = items.map((item, i) => {
    const want = shape.form(item);
    const was = byKey.get(shape.keyOfItem(item));
    const note = shape.comments?.[shape.keyOfItem(item)];
    if (!was) return (note ? `${indent}# ${note}\n` : '') + indentLines(render([want]), indent);
    const prefix = i === 0 ? '' : was.prefix;
    if (stableStringify(was.node.toJSON()) === stableStringify(want) && isScalar(was.node) === (typeof want === 'string')) return prefix + was.body;
    return prefix + indentLines(render([want], was.node), indent);
  });
  return text.slice(0, first.lineStart) + written.join('') + text.slice(last.bodyEnd);
}

/** A list of entries as block YAML. An inline comment on the entry it replaces stays on its first line. */
function render(forms: (string | Record<string, unknown>)[], replacing?: Node): string {
  const doc = new Document(forms.map(fromForm));
  const comment = isScalar(replacing) || isMap(replacing) ? replacing.comment : undefined;
  const first = (doc.contents as YAMLSeq).items[0];
  const line = isMap(first) ? first.items[0]?.value : first;
  if (comment && isScalar(line)) line.comment = comment;
  return doc.toString(RENDER);
}

/** Lists of refs read best on one line: `about: [entity:walk, screen:walks]`. */
function fromForm(form: string | Record<string, unknown>) {
  const node = new Document(form).contents as Node;
  if (isMap(node)) for (const pair of node.items) if (isSeq(pair.value)) pair.value.flow = true;
  return node;
}

function indentLines(block: string, indent: string) {
  return indent ? block.replace(/^(?=.)/gm, indent) : block;
}

function endOfLine(text: string, at: number) {
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl + 1;
}

/** Where a section is written: the file it came from, or the file it would have. */
function sourceOf(loaded: LoadedSpec, section: Section) {
  let source = loaded.sources[section];
  if (!source) {
    const single = loaded.layout === 'single';
    source = { path: join(specDir(loaded.root), single ? SINGLE_FILE : `${section}.yaml`), keyed: single };
    loaded.sources[section] = source;
  }
  return source;
}

function seqOf(doc: Document, section: Section, keyed: boolean): YAMLSeq | undefined {
  const node = keyed ? (isMap(doc.contents) ? doc.get(section, true) : undefined) : doc.contents;
  return isSeq(node) ? node : undefined;
}

/** Where a list in the declared tier lives: its file and its path in that file. */
function locate(loaded: LoadedSpec, section: 'personas' | 'domain' | 'journeys', path: (string | number)[]): { file: string; full: (string | number)[] } {
  if (section === 'journeys') {
    const [id, ...rest] = path;
    if (loaded.layout === 'split') return { file: join(specDir(loaded.root), 'journeys', `${String(id)}.yaml`), full: rest };
    const index = loaded.spec.journeys.findIndex((j) => j.id === id);
    if (index < 0) throw new Error(`no journey "${String(id)}"`);
    return { file: join(specDir(loaded.root), SINGLE_FILE), full: ['journeys', index, ...rest] };
  }
  const source = loaded.sources[section];
  if (!source) throw new Error(`the spec has no ${section} to change`);
  return { file: source.path, full: source.keyed ? [section, ...path] : path };
}

function fileOf(loaded: LoadedSpec, path: string) {
  const file = loaded.files.get(path);
  if (!file) throw new Error(`${path} was not read`);
  return file;
}

function save(loaded: LoadedSpec, path: string, out: string) {
  writeFileSync(path, out);
  loaded.files.set(path, { text: out, doc: parseDocument(out) });
  return path;
}

/** One entry of a block list: where its line starts and where it ends, and its indent. */
function entryLines(text: string, node: Node) {
  const [start = 0, valueEnd = 0, end = 0] = node.range ?? [];
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const bodyEnd = text[end - 1] === '\n' ? end : endOfLine(text, Math.max(valueEnd - 1, start));
  return { lineStart, bodyEnd, indent: text.slice(lineStart).match(/^ */)?.[0] ?? '' };
}

const asLine = (node: unknown) =>
  isScalar(node)
    ? String(node.value)
    : isMap(node) && node.items.length === 1
      ? `${String((node.items[0]?.key as Scalar)?.value)}: ${String((node.items[0]?.value as Scalar)?.value)}`
      : undefined;

/**
 * Replaces one entry of a list in the declared tier (`to`), or removes it (`to` null): a domain
 * rule, a persona capability, a journey step. Only that entry's line changes. Returns the file written.
 */
export function editInList(
  loaded: LoadedSpec,
  section: 'personas' | 'domain' | 'journeys',
  path: (string | number)[],
  from: string,
  to: string | null,
): string {
  const { file: path_, full } = locate(loaded, section, path);
  const { text, doc } = fileOf(loaded, path_);
  const seq = doc.getIn(full, true);
  if (!isSeq(seq)) throw new Error(`no list at ${full.join('.')}`);
  const item = (seq.items as Node[]).find((n) => asLine(n) === from);
  if (!item) throw new Error(`"${from}" isn't in ${full.join('.')}`);
  if (seq.flow) {
    const idx = seq.items.indexOf(item as never);
    if (to === null) seq.items.splice(idx, 1);
    else seq.items[idx] = doc.createNode(to) as never;
    return save(loaded, path_, doc.toString(RENDER));
  }
  const { lineStart, bodyEnd, indent } = entryLines(text, item);
  const line = to === null ? '' : `${indent}- ${new Document(to).toString(RENDER).trim()}\n`;
  return save(loaded, path_, text.slice(0, lineStart) + line + text.slice(bodyEnd));
}

/**
 * Appends a line to a list in the declared tier: a domain rule (`['walk', 'rules']` in domain), a
 * persona's can or cannot (`['owner', 'cannot']` in personas), or a journey step
 * (`['first-booking', 'steps']` in journeys), creating the list when there is none. Only the lines
 * it adds change; `comment` goes above them. Returns the file written.
 */
export function appendToList(
  loaded: LoadedSpec,
  section: 'personas' | 'domain' | 'journeys',
  path: (string | number)[],
  value: string,
  comment?: string,
): string {
  const { file: filePath, full } = locate(loaded, section, path);
  const { text, doc } = fileOf(loaded, filePath);
  const scalar = new Document(value).toString(RENDER).trim();
  const flowDoc = new Document([value]);
  (flowDoc.contents as YAMLSeq).flow = true;
  /** The value as it reads inside `[…]`, where commas and colons need quotes. */
  const inFlow = flowDoc.toString(RENDER).trim().slice(1, -1);
  const node = doc.getIn(full, true) as Node | undefined;
  const parent = doc.getIn(full.slice(0, -1), true) as Node | undefined;
  let out: string | undefined;

  if (isSeq(node) && node.range && !node.flow && node.items.length) {
    const last = node.items[node.items.length - 1] as Node;
    const first = node.items[0] as Node;
    const lineStart = text.lastIndexOf('\n', (first.range?.[0] ?? 0) - 1) + 1;
    const indent = text.slice(lineStart).match(/^ */)?.[0] ?? '';
    const end = last.range ? (text[last.range[2] - 1] === '\n' ? last.range[2] : endOfLine(text, last.range[1])) : text.length;
    const add = `${comment ? `${indent}# ${comment}\n` : ''}${indent}- ${scalar}\n`;
    out = text.slice(0, end) + (text[end - 1] === '\n' || end === 0 ? '' : '\n') + add + text.slice(end);
  } else if (isSeq(node) && node.range && node.flow) {
    const close = text.lastIndexOf(']', node.range[1]);
    out = `${text.slice(0, close)}${node.items.length ? ', ' : ''}${inFlow}${text.slice(close)}`;
  } else if (!node && isMap(parent) && parent.range && parent.flow) {
    const close = text.lastIndexOf('}', parent.range[1]);
    out = `${text.slice(0, close).replace(/\s*$/, '')}, ${full[full.length - 1]}: [${inFlow}] ${text.slice(close)}`;
  } else if (!node && isMap(parent) && parent.range && parent.items.length) {
    const firstKey = parent.items[0]?.key as Node | undefined;
    const keyStart = firstKey?.range?.[0] ?? parent.range[0];
    const indent = ' '.repeat(keyStart - (text.lastIndexOf('\n', keyStart - 1) + 1));
    const end = text[parent.range[2] - 1] === '\n' ? parent.range[2] : endOfLine(text, parent.range[1]);
    const add = `${comment ? `${indent}# ${comment}\n` : ''}${indent}${full[full.length - 1]}:\n${indent}  - ${scalar}\n`;
    out = text.slice(0, end) + (text[end - 1] === '\n' ? '' : '\n') + add + text.slice(end);
  }
  if (out === undefined) {
    // Nothing to splice into (a missing entity or persona): add it through the document.
    if (isSeq(node)) node.add(value);
    else doc.setIn(full, doc.createNode([value]));
    out = doc.toString(RENDER);
  }
  return save(loaded, filePath, out);
}
