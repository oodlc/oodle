// How Oodle runs the service: the real Express app, in process, with every outbound
// fetch routed through ctx.effects and the data layer seeded from ctx.state.
import { httpApp } from '@oodlc/oodle/adapter';
import { app } from './src/server.ts';
import { store } from './src/repo.ts';

export default httpApp(app, {
  effects: {
    'POST api.stripe.com/v1/charges': 'payment.charge',
    'POST api.stripe.com/v1/refunds': 'payment.refund',
    'api.sendgrid.com': 'email.sent',
  },
  setup(ctx) {
    store.users = new Map(Object.entries(ctx.state.users ?? {}));
    store.orders = new Map(Object.entries(ctx.state.orders ?? {}));
  },
});
