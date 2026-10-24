/**
 * Dog walks, written by hand: the fixture the simulation, verify and gaps are tested against.
 * dogwalk-b (test/fixtures/variants.ts) differs from it in exactly three planted ways.
 */
import { type OodleEnv, oodle, rt, type User } from '@oodle/runtime';
import { type Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';

type C = Context<OodleEnv>;

interface Walk {
  id: string;
  seq: number;
  owner_id: string;
  walker_id: string;
  starts_at: string;
  minutes: number;
  price_cents: number;
  status: string;
  charged_cents: number;
  rating: number | null;
  owner_name: string;
  walker_name: string;
  owner_email: string;
  owner_data: string;
}

const PRICES: Record<number, number> = { 30: 2000, 60: 3500 };
const FREE_CANCEL_MS = 2 * 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');
const when = (iso: string) => {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const endOf = (w: Walk) => Date.parse(w.starts_at) + w.minutes * 60_000;

function statusOf(c: C, w: Walk): string {
  if (w.status === 'accepted' && rt(c).now().getTime() >= endOf(w)) return `Done, ${money(w.price_cents)}`;
  if (w.status === 'cancelled') return w.charged_cents ? `Cancelled, charged ${money(w.charged_cents)}` : 'Cancelled, no charge';
  return `${w.status[0]?.toUpperCase()}${w.status.slice(1)}, ${money(w.price_cents)}`;
}

export const app = new Hono<OodleEnv>();
app.use(oodle());

function Page(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

const message = (c: C, status: 400 | 403 | 404 | 409, text: string) =>
  c.html(
    <Page title={text}>
      <p>{text}</p>
      <a href="/">Back to your walks</a>
    </Page>,
    status,
  );

const WALK_SQL = `SELECT w.*, o.name AS owner_name, o.email AS owner_email, o.data AS owner_data, k.name AS walker_name
  FROM walks w JOIN users o ON o.id = w.owner_id JOIN users k ON k.id = w.walker_id`;

const db = (c: C) => {
  if (!c.env.DB) throw new Error('no DB binding');
  return c.env.DB as unknown as D1Database;
};

async function walkFor(c: C, id: string): Promise<Walk | null> {
  return db(c).prepare(`${WALK_SQL} WHERE w.id = ?`).bind(id).first<Walk>();
}

const me = (c: C): User | undefined => rt(c).user();

app.get('/', async (c) => {
  const user = me(c);
  if (!user) {
    return c.html(
      <Page title="Dog walks">
        <h1>Dog walks</h1>
        <p>Sign in to book a walk.</p>
      </Page>,
    );
  }
  const column = user.persona === 'owner' ? 'owner_id' : 'walker_id';
  const { results } = await db(c).prepare(`${WALK_SQL} WHERE w.${column} = ? ORDER BY w.starts_at ASC, w.seq ASC`).bind(user.id).all<Walk>();
  return c.html(
    <Page title="Your walks">
      <h1>Your walks</h1>
      {results.length === 0 ? (
        <p>No walks yet.</p>
      ) : (
        <ul>
          {results.map((w) => (
            <li>
              <a href={`/walks/${w.id}`}>
                {when(w.starts_at)} {user.persona === 'owner' ? `with ${w.walker_name}` : `for ${w.owner_name}`}
              </a>
              : {statusOf(c, w)}
            </li>
          ))}
        </ul>
      )}
      {user.persona === 'owner' ? (
        <a href="/walks/new">Book a walk</a>
      ) : (
        <nav>
          <a href="/availability">Availability</a> <a href="/earnings">Earnings</a>
        </nav>
      )}
    </Page>,
  );
});

app.get('/walks/new', async (c) => {
  const user = me(c);
  if (user?.persona !== 'owner') return message(c, 403, 'Only owners can book walks.');
  const { results } = await db(c).prepare("SELECT id, name FROM users WHERE persona = 'walker' ORDER BY name").all<{ id: string; name: string }>();
  return c.html(
    <Page title="Book a walk">
      <h1>Book a walk</h1>
      <form method="post" action="/walks">
        <label>
          Walker
          <select name="walker">
            {results.map((w) => (
              <option value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>
        <label>
          Starts at
          <input type="datetime-local" name="starts_at" />
        </label>
        <label>
          Minutes
          <select name="minutes">
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
        </label>
        <button type="submit">Request walk</button>
      </form>
    </Page>,
  );
});

app.post('/walks', async (c) => {
  const user = me(c);
  if (user?.persona !== 'owner') return message(c, 403, 'Only owners can book walks.');
  const form = await c.req.parseBody();
  const walker = await db(c)
    .prepare("SELECT id, name FROM users WHERE id = ? AND persona = 'walker'")
    .bind(String(form.walker ?? ''))
    .first<{ id: string; name: string }>();
  if (!walker) return message(c, 400, 'Choose a walker.');
  const minutes = Number(form.minutes);
  const price = PRICES[minutes];
  if (!price) return message(c, 400, 'Choose 30 or 60 minutes.');
  const startsAt = Date.parse(String(form.starts_at ?? ''));
  if (Number.isNaN(startsAt)) return message(c, 400, 'Choose when the walk starts.');
  if (startsAt <= rt(c).now().getTime()) return message(c, 400, 'Choose a time in the future.');
  const id = rt(c).id('walk');
  const seq = Number(id.split('_')[1]);
  await db(c)
    .prepare('INSERT INTO walks (id, seq, owner_id, walker_id, starts_at, minutes, price_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, seq, user.id, walker.id, new Date(startsAt).toISOString(), minutes, price, 'requested', rt(c).now().toISOString())
    .run();
  return c.redirect(`/walks/${id}`, 303);
});

app.get('/walks/:id', async (c) => {
  const user = me(c);
  const w = await walkFor(c, c.req.param('id'));
  if (!user || !w || (w.owner_id !== user.id && w.walker_id !== user.id)) return message(c, 404, 'No such walk.');
  const isOwner = w.owner_id === user.id;
  const open = w.status === 'requested' || w.status === 'accepted';
  const address = (JSON.parse(w.owner_data || '{}') as { address?: string }).address;
  const done = w.status === 'accepted' && rt(c).now().getTime() >= endOf(w);
  return c.html(
    <Page title={`Walk ${when(w.starts_at)}`}>
      <h1>{isOwner ? `Walk with ${w.walker_name}` : `Walk for ${w.owner_name}`}</h1>
      <p>{statusOf(c, w)}</p>
      <p>
        {when(w.starts_at)}, {w.minutes} minutes
      </p>
      {!isOwner && w.status === 'accepted' && address ? <p>Pick up at {address}</p> : null}
      {w.rating ? <p>Rated {w.rating} out of 5</p> : null}
      {isOwner && open && !done ? (
        <form method="post" action={`/walks/${w.id}/cancel`}>
          <button type="submit">Cancel walk</button>
        </form>
      ) : null}
      {isOwner && done && !w.rating ? (
        <form method="post" action={`/walks/${w.id}/rate`}>
          <label>
            Stars
            <select name="stars">
              {[5, 4, 3, 2, 1].map((n) => (
                <option value={String(n)}>{n}</option>
              ))}
            </select>
          </label>
          <button type="submit">Rate {w.walker_name}</button>
        </form>
      ) : null}
      {!isOwner && w.status === 'requested' ? (
        <div>
          <form method="post" action={`/walks/${w.id}/accept`}>
            <button type="submit">Accept</button>
          </form>
          <form method="post" action={`/walks/${w.id}/decline`}>
            <button type="submit">Decline</button>
          </form>
        </div>
      ) : null}
      <a href="/">Back to your walks</a>
    </Page>,
  );
});

async function walkerAction(c: C, to: 'accepted' | 'declined') {
  const user = me(c);
  const w = await walkFor(c, c.req.param('id') as string);
  if (!user || !w || w.walker_id !== user.id) return message(c, 403, "You can't answer this walk.");
  if (w.status !== 'requested') return message(c, 409, 'This walk was already answered.');
  if (to === 'accepted') {
    const clash = await db(c)
      .prepare("SELECT id, starts_at, minutes FROM walks WHERE walker_id = ? AND status = 'accepted' AND id != ?")
      .bind(user.id, w.id)
      .all<{ starts_at: string; minutes: number }>();
    const start = Date.parse(w.starts_at);
    if (clash.results.some((o) => Date.parse(o.starts_at) < endOf(w) && start < Date.parse(o.starts_at) + o.minutes * 60_000)) {
      return message(c, 409, 'You already have a walk at that time.');
    }
  }
  await db(c).prepare('UPDATE walks SET status = ? WHERE id = ?').bind(to, w.id).run();
  await rt(c).mail.send(
    to === 'accepted'
      ? { to: w.owner_email, subject: `${w.walker_name} accepted your walk`, text: `${w.walker_name} will walk your dog on ${when(w.starts_at)}.` }
      : { to: w.owner_email, subject: `${w.walker_name} can't take your walk`, text: `${w.walker_name} declined your walk on ${when(w.starts_at)}.` },
  );
  return c.redirect(`/walks/${w.id}`, 303);
}

app.post('/walks/:id/accept', (c) => walkerAction(c, 'accepted'));
app.post('/walks/:id/decline', (c) => walkerAction(c, 'declined'));

app.post('/walks/:id/cancel', async (c) => {
  const user = me(c);
  const w = await walkFor(c, c.req.param('id'));
  if (!user || !w || w.owner_id !== user.id) return message(c, 403, "You can't cancel this walk.");
  if (w.status !== 'requested' && w.status !== 'accepted') return message(c, 409, 'This walk is already closed.');
  if (rt(c).now().getTime() > Date.parse(w.starts_at) - FREE_CANCEL_MS) return message(c, 409, "It's too late to cancel this walk.");
  await db(c).prepare("UPDATE walks SET status = 'cancelled', charged_cents = 0 WHERE id = ?").bind(w.id).run();
  return c.redirect(`/walks/${w.id}`, 303);
});

app.post('/walks/:id/rate', async (c) => {
  const user = me(c);
  const w = await walkFor(c, c.req.param('id'));
  if (!user || !w || w.owner_id !== user.id) return message(c, 403, "You can't rate this walk.");
  if (w.status !== 'accepted' || rt(c).now().getTime() < endOf(w)) return message(c, 409, 'You can rate a walk once it is done.');
  const stars = Number((await c.req.parseBody()).stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return message(c, 400, 'Choose 1 to 5 stars.');
  await db(c).prepare('UPDATE walks SET rating = ? WHERE id = ?').bind(stars, w.id).run();
  return c.redirect(`/walks/${w.id}`, 303);
});

app.get('/availability', async (c) => {
  const user = me(c);
  if (user?.persona !== 'walker') return message(c, 403, 'Only walkers set availability.');
  const a = await db(c)
    .prepare('SELECT from_time, to_time FROM availability WHERE walker_id = ?')
    .bind(user.id)
    .first<{ from_time: string; to_time: string }>();
  return c.html(
    <Page title="Availability">
      <h1>Availability</h1>
      <p>{a ? `Available ${a.from_time}–${a.to_time}` : 'No availability set.'}</p>
      <form method="post" action="/availability">
        <label>
          From
          <input type="time" name="from" value={a?.from_time ?? ''} />
        </label>
        <label>
          To
          <input type="time" name="to" value={a?.to_time ?? ''} />
        </label>
        <button type="submit">Save availability</button>
      </form>
    </Page>,
  );
});

app.post('/availability', async (c) => {
  const user = me(c);
  if (user?.persona !== 'walker') return message(c, 403, 'Only walkers set availability.');
  const form = await c.req.parseBody();
  const from = String(form.from ?? '');
  const to = String(form.to ?? '');
  if (!/^\d\d:\d\d$/.test(from) || !/^\d\d:\d\d$/.test(to) || from >= to) return message(c, 400, 'Choose a start time before the end time.');
  await db(c)
    .prepare(
      'INSERT INTO availability (walker_id, from_time, to_time) VALUES (?, ?, ?) ON CONFLICT (walker_id) DO UPDATE SET from_time = excluded.from_time, to_time = excluded.to_time',
    )
    .bind(user.id, from, to)
    .run();
  return c.redirect('/availability', 303);
});

app.get('/earnings', async (c) => {
  const user = me(c);
  if (user?.persona !== 'walker') return message(c, 403, 'Only walkers have earnings.');
  const { results } = await db(c).prepare(`${WALK_SQL} WHERE w.walker_id = ? AND w.status = 'accepted' ORDER BY w.starts_at ASC`).bind(user.id).all<Walk>();
  const done = results.filter((w) => rt(c).now().getTime() >= endOf(w));
  return c.html(
    <Page title="Earnings">
      <h1>Earnings</h1>
      <p>{money(done.reduce((sum, w) => sum + w.price_cents, 0))} earned</p>
      {done.length ? (
        <ul>
          {done.map((w) => (
            <li>
              {when(w.starts_at)} for {w.owner_name}: {money(w.price_cents)}
            </li>
          ))}
        </ul>
      ) : (
        <p>No finished walks yet.</p>
      )}
    </Page>,
  );
});

app.notFound((c) => message(c, 404, 'Not found.'));

export default app;
