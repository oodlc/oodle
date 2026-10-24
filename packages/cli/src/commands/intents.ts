import type { IntentChecks } from '@oodle/verify';
import type { Ctx } from '../context.ts';

/** The checks merged intents add to verify. Filled in with intents (phase 9). */
export async function intentChecks(_ctx: Ctx, _buildDir: string): Promise<IntentChecks | undefined> {
  return undefined;
}
