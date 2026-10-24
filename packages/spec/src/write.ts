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
import { Document, isMap, isScalar, isSeq, type Node, parseDocument, type YAMLSeq } from 'yaml';
import { decisionId, stableStringify } from './hash.ts';
import { type LoadedSpec, SINGLE_FILE, specDir } from './load.ts';
import type { Constraint, Decision } from './schema.ts';

const DECISION_KEYS = ['id', 'text', 'about', 'source', 'status', 'created_by_build', 'answered_by', 'from_gap'] as const;
const RENDER = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Writes the decisions, in this order. Returns the file written. */
export function writeDecisions(loaded: LoadedSpec, decisions: Decision[]): string {
  const path = writeList(loaded, 'decisions', decisions, {
    keyOf: (node) => (isScalar(node) ? decisionId(String(node.value)) : isMap(node) ? String(node.get('id')) : undefined),
    keyOfItem: (d) => d.id,
    form: (d) => Object.fromEntries(DECISION_KEYS.filter((k) => d[k] !== undefined && !(k === 'about' && d.about.length === 0)).map((k) => [k, d[k]])),
  });
  loaded.spec.decisions = decisions;
  return path;
}

/** Writes the constraints, in this order. Returns the file written. */
export function writeConstraints(loaded: LoadedSpec, constraints: Constraint[]): string {
  const path = writeList(loaded, 'constraints', constraints, {
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

  writeFileSync(source.path, out);
  loaded.files.set(source.path, { text: out, doc: parseDocument(out) });
  return source.path;
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
    if (!was) return indentLines(render([want]), indent);
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
