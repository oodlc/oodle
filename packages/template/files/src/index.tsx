import { type OodleEnv, oodle, rt } from '@oodle/runtime';
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';

export const app = new Hono<OodleEnv>();

// Simulation control routes (404 in production) and the persona session.
app.use(oodle());

export function Page(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

app.onError((err, c) => {
  rt(c).log('error', { message: err.message });
  return c.html(
    <Page title="Something went wrong">
      <h1>Something went wrong</h1>
    </Page>,
    500,
  );
});

app.notFound((c) =>
  c.html(
    <Page title="Not found">
      <h1>Not found</h1>
    </Page>,
    404,
  ),
);

app.get('/', (c) =>
  c.html(
    <Page title="Home">
      <h1>Home</h1>
    </Page>,
  ),
);

export default app;
