import { useState } from 'react';
import type { IntentChange, IntentDetailResponse, ReviewResponse } from '../../shared/protocol.ts';
import { ApiFailure, api, useLoad } from '../api.ts';
import { describeChange, humanize, kindLabel, openRaised, paths, rulesOutLabel, statusLabel } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { Problem, useSession } from '../session.tsx';

export function IntentScreen({ project, id }: { project: string; id: string }) {
  const base = `/projects/${encodeURIComponent(project)}/intents/${encodeURIComponent(id)}`;
  const detail = useLoad(base, () => api<IntentDetailResponse>('GET', base));
  const session = useSession();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  if (detail.error) return <Problem error={detail.error} />;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { intent, approvals, gaps, role } = detail.data;
  const body = intent.body;
  const open = openRaised(gaps);
  const canReview = role !== 'viewer';

  async function review(decision: 'approve' | 'reject') {
    setBusy(true);
    setMessage(null);
    try {
      await api<ReviewResponse>('POST', `${base}/review`, { decision, note, content_hash: intent.content_hash });
      setMessage({ kind: 'ok', text: decision === 'approve' ? 'Approved. The change can be merged.' : 'Rejected.' });
      setNote('');
      session.reload();
    } catch (e) {
      setMessage({ kind: e instanceof ApiFailure && e.status === 409 ? 'warn' : 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      detail.reload();
    }
  }

  return (
    <article className="intent">
      <p className="crumbs small">
        <Link to={paths.inbox()}>Inbox</Link> / {project}
      </p>
      <p className="small">
        <span className="badge">Change</span> <span className="muted">{humanize(intent.status)}</span>
      </p>
      <h1>{body.title}</h1>
      {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

      <section>
        <h3>Why</h3>
        <p>{body.why || <span className="muted">No reason given.</span>}</p>
      </section>

      <section>
        <h3>What changes in the spec</h3>
        {body.changes.length === 0 && <p className="muted">No changes listed.</p>}
        {body.changes.map((ch, i) => (
          // Changes have no ids; their order is part of the intent.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Change key={i} change={ch} />
        ))}
      </section>

      <div className="two">
        <section>
          <h3>Must stay true</h3>
          <List
            items={[...(body.keeps?.journeys ?? []).map((j) => `The journey "${j}" still passes`), ...(body.keeps?.constraints ?? [])]}
            empty="Nothing named."
          />
        </section>
        <section>
          <h3>Rules out</h3>
          <List items={(body.rules_out ?? []).map(rulesOutLabel)} empty="Nothing ruled out." />
        </section>
      </div>
      <section>
        <h3>Done when</h3>
        <List
          items={[
            ...(body.done_when?.journeys ?? []).map((j) => `The journey "${j}" exists and passes`),
            ...(body.done_when?.evals ?? []).map((e) => `The eval "${e}" passes`),
          ]}
          empty="No finish line named."
        />
      </section>

      <section>
        <h3>Questions this change raised</h3>
        {gaps.length === 0 ? (
          <p className="muted">The two builds of this change agreed on everything.</p>
        ) : (
          <ul className="rows">
            {gaps.map((g) => (
              <li key={g.id}>
                <span className="badge">{kindLabel(g.kind)}</span>
                <Link to={paths.gap(project, g.id)}>{g.question}</Link>
                <span className={`small ${g.status === 'open' ? 'warn-text' : 'muted'}`}>{statusLabel(g.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canReview && (
        <section className="review">
          <h3>Your review</h3>
          <label>
            Note (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
          <div className="secondary">
            <button type="button" className="primary" disabled={busy || open > 0} onClick={() => review('approve')}>
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => review('reject')}>
              Reject
            </button>
            {open > 0 && <span className="muted small">Answer the {open} open question(s) above before approving.</span>}
          </div>
        </section>
      )}

      {approvals.length > 0 && (
        <section>
          <h3>Reviews</h3>
          <ul className="rows small">
            {approvals.map((a) => (
              <li key={a.id}>
                {a.decision === 'approve' ? 'Approved' : 'Rejected'} by {a.by_email} · {new Date(a.at).toLocaleString()}
                {a.note && <> · “{a.note}”</>}
                {!a.current && <span className="badge warn">The change was edited after this review, so it no longer counts</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function Change({ change }: { change: IntentChange }) {
  const v = describeChange(change);
  return (
    <div className="change">
      <div className="change-title">{v.title}</div>
      {v.before !== undefined && (
        <div className="before">
          <span className="small muted">Before</span>
          <p>{v.before}</p>
        </div>
      )}
      {v.after !== undefined && (
        <div className="after">
          <span className="small muted">After</span>
          <p>{v.after}</p>
        </div>
      )}
      {v.details.length > 0 && (
        <dl className="small">
          {v.details.map(([k, val]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul>
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  );
}
