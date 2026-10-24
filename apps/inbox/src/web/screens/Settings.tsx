import { useState } from 'react';
import type { CreateTokenResponse, Role, TokenRecord } from '../../shared/protocol.ts';
import { api, useLoad } from '../api.ts';
import { paths, who } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { Problem } from '../session.tsx';

/** Owners only (the API enforces it): who is on the project, and the CLI's project tokens. */
export function SettingsScreen({ project }: { project: string }) {
  const base = `/projects/${encodeURIComponent(project)}`;
  const members = useLoad(`${base}/members`, () => api<{ members: { email: string; role: Role }[] }>('GET', `${base}/members`));
  const tokens = useLoad(`${base}/tokens`, () => api<{ tokens: TokenRecord[] }>('GET', `${base}/tokens`));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('answerer');
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<CreateTokenResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const attempt = (fn: () => Promise<void>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <article>
      <p className="crumbs small">
        <Link to={paths.inbox()}>Inbox</Link> / {project}
      </p>
      <h1>People and tokens</h1>
      {error && <Problem error={error} />}

      <section>
        <h3>People</h3>
        {members.error && <Problem error={members.error} />}
        <ul className="rows">
          {members.data?.members.map((m) => (
            <li key={m.email}>
              {m.email} <span className="badge">{m.role}</span>
            </li>
          ))}
        </ul>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(async () => {
              await api('POST', `${base}/members`, { email, role });
              setEmail('');
              members.reload();
            })();
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="answerer">answerer</option>
            <option value="viewer">viewer</option>
            <option value="owner">owner</option>
          </select>
          <button type="submit">Add or change</button>
        </form>
      </section>

      <section>
        <h3>Project tokens</h3>
        <p className="muted small">The CLI uses a token to push gaps and pull answers. A token can never answer or approve anything.</p>
        {fresh && (
          <div className="banner ok">
            New token <strong>{fresh.label ?? fresh.id}</strong>. Copy it now; it is not shown again:
            <pre>{fresh.token}</pre>
          </div>
        )}
        {tokens.error && <Problem error={tokens.error} />}
        <ul className="rows">
          {tokens.data?.tokens.map((t) => (
            <li key={t.id}>
              {t.label ?? t.id} <span className="muted small">by {who(t.created_by)}</span>
              {t.revoked_at ? (
                <span className="muted small">revoked</span>
              ) : (
                <button
                  type="button"
                  className="link"
                  onClick={attempt(async () => {
                    await api('DELETE', `${base}/tokens/${t.id}`);
                    tokens.reload();
                  })}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(async () => {
              setFresh(await api<CreateTokenResponse>('POST', `${base}/tokens`, { label }));
              setLabel('');
              tokens.reload();
            })();
          }}
        >
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label, e.g. ci or jp-laptop" />
          <button type="submit">Create a token</button>
        </form>
      </section>
    </article>
  );
}
