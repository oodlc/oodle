/**
 * The one way Oodle asks a model for something: a system prompt, a prompt, and a zod schema the
 * answer must match. The default model runs through the Claude Agent SDK with every tool turned
 * off, so it uses whatever credentials Claude Code has (an API key or a login). Tests pass a
 * scripted model instead.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface Ask<T> {
  /** What the call is for, in logs and errors: `compile journey first-booking`. */
  label: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Model {
  /** Who answers, as recorded in `answered_by`: `agent:<model>@local`. */
  readonly name: string;
  json<T>(ask: Ask<T>): Promise<T>;
  readonly usage: Usage;
}

export class ModelError extends Error {}

export const DEFAULT_MODEL = process.env.OODLE_MODEL ?? 'claude-sonnet-5-5';

export function agentModel(opts: { model?: string } = {}): Model {
  const model = opts.model ?? DEFAULT_MODEL;
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    name: model,
    usage,
    async json<T>(ask: Ask<T>): Promise<T> {
      const schema = z.toJSONSchema(ask.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
      let result: unknown;
      let failure: string | undefined;
      for await (const message of query({
        prompt: ask.prompt,
        options: {
          model,
          systemPrompt: ask.system,
          tools: [],
          maxTurns: 4,
          settingSources: [],
          outputFormat: { type: 'json_schema', schema },
        },
      })) {
        if (message.type !== 'result') continue;
        usage.calls++;
        usage.costUsd += message.total_cost_usd ?? 0;
        usage.inputTokens += message.usage?.input_tokens ?? 0;
        usage.outputTokens += message.usage?.output_tokens ?? 0;
        if (message.subtype === 'success') result = message.structured_output;
        else failure = message.subtype;
      }
      if (result === undefined) throw new ModelError(`${ask.label}: the model gave no answer${failure ? ` (${failure})` : ''}`);
      const parsed = ask.schema.safeParse(result);
      if (!parsed.success)
        throw new ModelError(`${ask.label}: the model's answer doesn't fit: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return parsed.data;
    },
  };
}

/**
 * A model that answers from a script, for tests and for replaying recorded answers. Each answer
 * is matched by the start of its call's label; an unmatched call is an error.
 */
export function scriptedModel(answers: Record<string, unknown | ((ask: Ask<unknown>) => unknown)>, name = 'scripted'): Model & { asked: string[] } {
  const asked: string[] = [];
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    name,
    usage,
    asked,
    async json<T>(ask: Ask<T>): Promise<T> {
      asked.push(ask.label);
      usage.calls++;
      const key = Object.keys(answers)
        .filter((k) => ask.label.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new ModelError(`${ask.label}: no scripted answer`);
      const answer = answers[key];
      const value = typeof answer === 'function' ? (answer as (a: Ask<unknown>) => unknown)(ask as Ask<unknown>) : answer;
      return ask.schema.parse(value);
    },
  };
}
