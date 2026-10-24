import { describe, expect, it } from 'vitest';
import { screenText, viewOf } from '../src/index.ts';

describe('viewOf', () => {
  const html = `<!doctype html><html><head><title> Your walks </title><style>.x{}</style><script>var a = 1</script></head>
  <body class="theme"><main>
    <h1>Your   walks</h1>
    <p>Hello <b>Ada</b>, you have <span>2</span> walks.</p>
    <p hidden>secret</p><div style="display: none">also secret</div><p aria-hidden="true">nope</p>
    <ul><li><a href="/walks/1">Tue 3 Nov</a>: Requested</li><li>Wed 4 Nov: Accepted</li></ul>
    <table><tr><th>Day</th><th>Price</th></tr><tr><td>Tue</td><td>$20.00</td></tr></table>
    <form>
      <label for="w">Walker</label><select id="w" name="walker"><option>Sam</option><option selected>Tom</option></select>
      <label>Minutes <input name="minutes" value="30" aria-describedby="m-err"></label><span id="m-err">Choose 30 or 60</span>
      <input type="hidden" name="csrf" value="x">
      <input placeholder="Note" name="note">
      <button type="submit" class="btn">Request walk</button>
      <input type="submit" value="Save">
    </form>
    <a href="/new" aria-label="Book a walk"><svg><text>+</text></svg></a>
  </main></body></html>`;

  it('reads what a user sees, and nothing else', () => {
    expect(viewOf(html)).toEqual({
      title: 'Your walks',
      headings: ['Your walks'],
      text: ['Hello Ada, you have 2 walks.'],
      lists: [{ items: ['Tue 3 Nov: Requested', 'Wed 4 Nov: Accepted'] }, { items: ['Day | Price', 'Tue | $20.00'] }],
      actions: ['Request walk', 'Save', 'Book a walk'],
      fields: [{ label: 'Walker', value: 'Tom' }, { label: 'Minutes', value: '30', error: 'Choose 30 or 60' }, { label: 'Note' }],
    });
  });

  it('ignores classes, ids and other attributes', () => {
    expect(viewOf('<p class="a" id="x" data-k="1">Hi</p>')).toEqual(viewOf('<p class="b">Hi</p>'));
  });

  it('flattens everything for screen_contains', () => {
    expect(screenText(viewOf(html))).toContain('Tue 3 Nov: Requested');
  });

  it('reads an empty page as an empty view', () => {
    expect(viewOf('')).toEqual({ headings: [], text: [], lists: [], actions: [], fields: [] });
  });
});
