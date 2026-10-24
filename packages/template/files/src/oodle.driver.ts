import type { Driver } from '@oodle/runtime';

/**
 * How the simulation uses the app: one action per entry in oodle/compiled/actions.json, each going
 * through HTTP with `s.fetch` and returning the screen the user lands on, plus the named screens
 * journeys look at. The generator fills this in.
 */
export const driver: Driver = {
  actions: {},
  screens: {
    home: () => '/',
  },
};
