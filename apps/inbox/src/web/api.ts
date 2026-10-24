import { useCallback, useEffect, useState } from 'react';
import type { ErrorResponse } from '../shared/protocol.ts';

/** A non-2xx answer from /api/ui, with its JSON body (which carries the current gap or intent on 409). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorResponse,
  ) {
    super(body.message || `Request failed (${status})`);
  }
}

/** Local development only: the identity `wrangler dev` uses when DEV_AUTH=1. Ignored in production. */
const devEmail = () => {
  try {
    return localStorage.getItem('oodle.devEmail');
  } catch {
    return null;
  }
};

export async function api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const dev = devEmail();
  if (dev) headers['X-Oodle-Dev-Email'] = dev;
  const res = await fetch(`/api/ui${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({ error: 'bad_response', message: `The inbox answered ${res.status}.` }))) as unknown;
  if (!res.ok) throw new ApiFailure(res.status, json as ErrorResponse);
  return json as T;
}

/** Load once per `key`; `reload` refetches. */
export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` fetches.
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload, set: (data: T) => setState({ data, loading: false }) };
}
