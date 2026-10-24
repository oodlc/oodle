/**
 * What a user sees on a server-rendered page, read from its HTML: the title, headings, text
 * blocks, lists (and table rows), actions (links and buttons, by accessible name) and form
 * fields. Scripts, styles and hidden elements are skipped; attributes other than accessible
 * names are ignored, so class names and ids never make two screens differ.
 */
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import type { ViewModel } from './scenario.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'svg', 'iframe']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'form',
  'fieldset',
  'legend',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'address',
  'body',
  'html',
  'br',
  'hr',
  'tr',
  'td',
  'th',
  'caption',
]);
const CONTROLS = new Set(['input', 'select', 'textarea']);
const BUTTON_INPUTS = new Set(['submit', 'button', 'reset', 'image']);

const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function hidden(el: Element): boolean {
  if (attr(el, 'hidden') !== undefined || attr(el, 'aria-hidden') === 'true') return true;
  if (el.tagName === 'input' && attr(el, 'type') === 'hidden') return true;
  const style = (attr(el, 'style') ?? '').replace(/\s/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

/** The visible text inside a node, whitespace collapsed. */
function textOf(node: Node): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.nodeName === '#text') parts.push((n as DefaultTreeAdapterMap['textNode']).value);
    else if (isElement(n)) {
      if (SKIP.has(n.tagName) || hidden(n)) return;
      if (BLOCKS.has(n.tagName)) parts.push(' ');
      for (const c of n.childNodes) visit(c);
      if (BLOCKS.has(n.tagName)) parts.push(' ');
    }
  };
  visit(node);
  return squash(parts.join(''));
}

function elements(root: Node): Element[] {
  const out: Element[] = [];
  const visit = (n: Node) => {
    if (isElement(n)) out.push(n);
    if ('childNodes' in n) for (const c of n.childNodes) visit(c);
    if (isElement(n) && n.tagName === 'template' && 'content' in n) visit((n as DefaultTreeAdapterMap['template']).content);
  };
  visit(root);
  return out;
}

export function viewOf(html: string): ViewModel {
  const doc = parse(html);
  const all = elements(doc);
  const byId = new Map(all.filter((e) => attr(e, 'id')).map((e) => [attr(e, 'id') as string, e]));
  const labelFor = new Map(all.filter((e) => e.tagName === 'label' && attr(e, 'for')).map((e) => [attr(e, 'for') as string, e]));

  const view: ViewModel = { headings: [], text: [], lists: [], actions: [], fields: [] };
  const title = all.find((e) => e.tagName === 'title');
  if (title) view.title = textOf(title);

  let buffer: string[] = [];
  const flush = () => {
    const t = squash(buffer.join(''));
    if (t) view.text.push(t);
    buffer = [];
  };

  const nameOf = (el: Element) =>
    squash(attr(el, 'aria-label') ?? '') || textOf(el) || squash(attr(el, 'title') ?? '') || squash(attr(el, 'value') ?? '') || squash(attr(el, 'alt') ?? '');

  const labelOf = (el: Element, ancestors: Element[]) => {
    const aria = attr(el, 'aria-label');
    if (aria) return squash(aria);
    const id = attr(el, 'id');
    const forLabel = id ? labelFor.get(id) : undefined;
    if (forLabel) return textOf(forLabel);
    const wrapping = [...ancestors].reverse().find((a) => a.tagName === 'label');
    if (wrapping) return textOf(wrapping);
    return squash(attr(el, 'placeholder') ?? attr(el, 'name') ?? '');
  };

  const fieldValue = (el: Element) => {
    if (el.tagName === 'textarea') return textOf(el) || undefined;
    if (el.tagName === 'select') {
      const options = elements(el).filter((o) => o.tagName === 'option');
      const chosen = options.find((o) => attr(o, 'selected') !== undefined) ?? options[0];
      return chosen ? textOf(chosen) : undefined;
    }
    const type = attr(el, 'type') ?? 'text';
    if (type === 'checkbox' || type === 'radio') return attr(el, 'checked') !== undefined ? 'checked' : 'unchecked';
    return attr(el, 'value') || undefined;
  };

  const errorOf = (el: Element) => {
    const ids = `${attr(el, 'aria-errormessage') ?? ''} ${attr(el, 'aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
    const text = ids
      .map((i) => byId.get(i))
      .filter((e): e is Element => !!e)
      .map(textOf)
      .filter(Boolean)
      .join(' ');
    return text || undefined;
  };

  /** Ids of elements whose text is read as a field's error, so it isn't also read as a text block. */
  const errorIds = new Set(
    all.flatMap((e) =>
      CONTROLS.has(e.tagName) ? `${attr(e, 'aria-errormessage') ?? ''} ${attr(e, 'aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean) : [],
    ),
  );

  const walk = (node: Node, ancestors: Element[]) => {
    if (node.nodeName === '#text') {
      buffer.push((node as DefaultTreeAdapterMap['textNode']).value);
      return;
    }
    if (!isElement(node)) {
      if ('childNodes' in node) for (const c of node.childNodes) walk(c, ancestors);
      return;
    }
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag) || hidden(el) || tag === 'title') return;
    if (attr(el, 'id') && errorIds.has(attr(el, 'id') as string)) return;
    if (HEADINGS.has(tag)) {
      flush();
      const t = textOf(el);
      if (t) view.headings.push(t);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      view.lists.push({ items: el.childNodes.filter((c): c is Element => isElement(c) && c.tagName === 'li' && !hidden(c)).map(textOf) });
      return;
    }
    if (tag === 'table') {
      flush();
      const rows = elements(el).filter((r) => r.tagName === 'tr' && !hidden(r));
      view.lists.push({
        items: rows.map((r) =>
          r.childNodes
            .filter(isElement)
            .filter((c) => !hidden(c))
            .map(textOf)
            .join(' | '),
        ),
      });
      return;
    }
    if ((tag === 'a' && attr(el, 'href') !== undefined) || tag === 'button' || (tag === 'input' && BUTTON_INPUTS.has(attr(el, 'type') ?? ''))) {
      const name = nameOf(el);
      if (name) view.actions.push(name);
      return;
    }
    if (CONTROLS.has(tag)) {
      const field: ViewModel['fields'][number] = { label: labelOf(el, ancestors) };
      const value = fieldValue(el);
      const error = errorOf(el);
      if (value !== undefined) field.value = value;
      if (error !== undefined) field.error = error;
      view.fields.push(field);
      return;
    }
    if (tag === 'label' && (attr(el, 'for') || elements(el).some((e) => CONTROLS.has(e.tagName)))) {
      // The label is read as its control's name; only the control itself is walked.
      flush();
      for (const c of elements(el).filter((e) => CONTROLS.has(e.tagName))) walk(c, [...ancestors, el]);
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) flush();
    for (const c of el.childNodes) walk(c, [...ancestors, el]);
    if (block) flush();
  };

  walk(doc, []);
  flush();
  return view;
}

/** Every piece of text on the screen, for `screen_contains`. */
export function screenText(view: ViewModel): string {
  return [
    view.title ?? '',
    ...view.headings,
    ...view.text,
    ...view.lists.flatMap((l) => l.items),
    ...view.actions,
    ...view.fields.flatMap((f) => [f.label, f.value ?? '', f.error ?? '']),
  ].join('\n');
}
