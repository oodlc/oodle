// How Oodle runs the service: the real Express app, in process, with every outbound fetch
// routed through ctx.effects. The database needs nothing here: `database` in oodlc/config.yaml
// gives the app a real Postgres on DATABASE_URL, seeded from given.db for every run.
import { httpApp } from '@oodlc/oodle/adapter';
import { app } from './src/server.ts';

export default httpApp(app, {
  effects: {
    'POST api.stripe.com/v1/charges': 'payment.charge',
    'POST api.stripe.com/v1/refunds': 'payment.refund',
    'api.sendgrid.com': 'email.sent',
  },
});
