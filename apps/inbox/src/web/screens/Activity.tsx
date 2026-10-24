import { useState } from 'react';
import type { ActivityResponse } from '../../shared/protocol.ts';
import { api, useLoad } from '../api.ts';
import { eventSummary, paths, who } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { Problem } from '../session.tsx';

const TYPES = [
  ['', 'Everything'],
  ['gap', 'Questions'],
  ['answer', 'Answers applied'],
  ['conflict', 'Conflicts'],
  ['intent', 'Changes'],
  ['token', 'Tokens'],
  ['member', 'People'],
] as const;

export function ActivityScreen({ project }: { project: string }) {
  const [type, setType] = useState('');
  const [actor, setActor] = useState('');
  const query = new URLSearchParams({ ...(type ? { type } : {}), ...(actor.trim() ? { actor: actor.trim() } : {}) }).toString();
  const path = `/projects/${encodeURIComponent(project)}/activity${query ? `?${query}` : ''}`;
  const log = useLoad(path, () => api<ActivityResponse>('GET', path));

  return (
    <article>
      <p className="crumbs small">
        <Link to={paths.inbox()}>Inbox</Link> / {project}
      </p>
      <h1>Activity</h1>
      <div className="filters">
        <label className="inline">
          Show{' '}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          By <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="email or token" />
        </label>
      </div>
      {log.error && <Problem error={log.error} />}
      {log.data && log.data.events.length === 0 && <p className="muted">Nothing yet.</p>}
      {log.data && log.data.events.length > 0 && (
        <table className="log">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {log.data.events.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{new Date(e.at).toLocaleString()}</td>
                <td>{who(e.actor)}</td>
                <td className="nowrap">{e.type}</td>
                <td className="small">
                  {typeof e.data.gap === 'string' ? <Link to={paths.gap(project, e.data.gap)}>{eventSummary(e.data)}</Link> : eventSummary(e.data)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
