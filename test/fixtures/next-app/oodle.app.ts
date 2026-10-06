// How Oodle runs this Next.js app. test/next.test.ts points the import at Oodle's source.
import { nextApp } from '@oodlc/oodle/next';
import { db } from './app/_lib/store';

export default nextApp({
  dir: __dirname,
  effects: { 'POST api.payments.test/v1/charges': 'payment.charge' },
  setup(ctx) {
    db.orders = new Map(Object.entries(ctx.state.orders ?? {}));
  },
});
