import { useState } from 'react';
import type { AnswerBody, AnswerResponse, EvidenceSide, GapDetailResponse, GapRecord, RuleTarget } from '../../shared/protocol.ts';
import { ApiFailure, api, useLoad } from '../api.ts';
import { answerInWords, decisionEffect, kindLabel, paths, sampleLines, scenarioInWords, statusLabel, targetLabel, who } from '../lib/format.ts';
import { Link } from '../router.tsx';
import { Problem, useSession } from '../session.tsx';

export function GapScreen({ project, id }: { project: string; id: string }) {
  const base = `/projects/${encodeURIComponent(project)}/gaps/${encodeURIComponent(id)}`;
  const detail = useLoad(base, () => api<GapDetailResponse>('GET', base));
  const session = useSession();
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  if (detail.error) return <Problem error={detail.error} />;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { gap, answers, conflicts, role } = detail.data;
  const me = `person:${session.data.me}`;
  const canAnswer = role !== 'viewer' && gap.status !== 'superseded';

  async function submit(answer: AnswerBody) {
    setMessage(null);
    try {
      await api<AnswerResponse>('POST', `${base}/answer`, { ...answer, version: gap.version });
      setMessage({ kind: 'ok', text: 'Answer recorded. It reaches the spec on the next `oodle sync`.' });
      session.reload();
      detail.reload();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        setMessage({ kind: 'warn', text: e.body.message });
        detail.reload();
      } else setMessage({ kind: 'error', text: (e as Error).message });
    }
  }

  async function resolve(conflict: string, resolution: 'keep' | 'take') {
    try {
      await api('POST', `${base}/conflicts/${conflict}/resolve`, { resolution });
      detail.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    }
  }

  const openConflicts = conflicts.filter((c) => !c.resolved_at);
  const canResolve = role === 'owner' || gap.answer?.answered_by === me;

  return (
    <article className="gap">
      <p className="crumbs small">
        <Link to={paths.inbox()}>Inbox</Link> / {project}
        {gap.intent_id && (
          <>
            {' '}
            / <Link to={paths.intent(project, gap.intent_id)}>the change that raised this</Link>
          </>
        )}
      </p>
      <p className="small">
        <span className="badge">{kindLabel(gap.kind)}</span> <span className="muted">{statusLabel(gap.status)}</span>
        {gap.tier === 'declared' && <span className="muted"> · touches what people declared</span>}
      </p>
      <h1>{gap.question}</h1>
      {gap.note && <div className="banner warn">{gap.note}</div>}
      {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

      <p className="scenario">{scenarioInWords(gap.body.evidence)}</p>
      <div className="sides">
        <Side label="One build" side={gap.body.evidence.a} ordered={gap.kind === 'sort_order'} />
        <Side label="The other build" side={gap.body.evidence.b} ordered={gap.kind === 'sort_order'} />
      </div>

      {gap.answer && (
        <p className="answered">
          <strong>{who(gap.answer.answered_by)}</strong> answered: {answerInWords(gap.answer.answer, gap.body)}
          {gap.answer.applied_sha ? <span className="muted small"> · applied to the spec</span> : <span className="muted small"> · not yet applied</span>}
        </p>
      )}
      {!gap.answer && gap.body.answer && (
        <p className="answered">
          <strong>{who(gap.body.answered_by)}</strong> settled this locally: {answerInWords(gap.body.answer, gap.body)}
          {gap.body.answer.reason && <span className="muted"> ({gap.body.answer.reason})</span>}
        </p>
      )}

      {openConflicts.map((c) => (
        <div key={c.id} className="banner warn">
          <strong>{who(c.answered_by)}</strong> answered differently: {answerInWords(c.answer, gap.body)}.
          {canResolve ? (
            <span className="actions">
              <button type="button" onClick={() => resolve(c.id, 'keep')}>
                Keep the current answer
              </button>
              <button type="button" onClick={() => resolve(c.id, 'take')}>
                Use theirs
              </button>
            </span>
          ) : (
            <span className="muted"> {who(gap.answer?.answered_by)} decides which stands.</span>
          )}
        </div>
      ))}

      {canAnswer ? <AnswerForm gap={gap} onAnswer={submit} /> : role === 'viewer' && <p className="muted">You can read this project but not answer.</p>}

      {answers.length > 0 && (
        <section>
          <h3>History</h3>
          <ul className="rows small">
            {answers.map((a) => (
              <li key={a.id}>
                #{a.seq} · {who(a.answered_by)} · {answerInWords(a.answer, gap.body)} · {new Date(a.answered_at).toLocaleString()}
                {a.applied_sha && <span className="muted"> · applied in {a.applied_sha.slice(0, 7)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function Side({ label, side, ordered }: { label: string; side: EvidenceSide; ordered: boolean }) {
  const lines = sampleLines(side.sample);
  const List = ordered ? 'ol' : 'ul';
  return (
    <div className="side">
      <div className="muted small">{label}</div>
      <div className="summary">{side.summary}</div>
      {lines.length > 0 && (
        <List className="sample">
          {lines.map((l, i) => (
            // Samples are plain values; position is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i}>{l}</li>
          ))}
        </List>
      )}
    </div>
  );
}

function AnswerForm({ gap, onAnswer }: { gap: GapRecord; onAnswer: (a: AnswerBody) => Promise<void> }) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<RuleTarget>('decision');
  const [busy, setBusy] = useState(false);
  const run = (a: AnswerBody) => async () => {
    setBusy(true);
    await onAnswer(a);
    setBusy(false);
  };
  const options = gap.body.options.filter((o) => o.id !== 'dont_care');
  const standing = gap.answer?.answer ?? null;

  return (
    <section className="answer">
      <h3>{gap.answer ? 'Change the answer' : 'Your answer'}</h3>
      <div className="options">
        {options.map((o) => {
          const effect = decisionEffect(gap.body, o.id, standing);
          return (
            <button key={o.id} type="button" className="option" disabled={busy} onClick={run({ option: o.id })}>
              <span className="label">{o.label}</span>
              {effect.adds && <span className="effect small">Adds the decision “{effect.adds}”</span>}
              {effect.replaces && <span className="effect small replaces">Replaces “{effect.replaces}”</span>}
            </button>
          );
        })}
      </div>
      <div className="secondary">
        <button type="button" disabled={busy} onClick={run({ dont_care: true })}>
          Either is fine
        </button>
        <button type="button" disabled={busy} onClick={run({ dismiss: true })}>
          Not a real difference
        </button>
        <button type="button" className="link" onClick={() => setWriting(!writing)}>
          {writing ? 'Never mind' : 'Write a rule instead'}
        </button>
      </div>
      {writing && (
        <form
          className="rule"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void run({ text: text.trim(), target })();
          }}
        >
          <label>
            The rule, in plain words
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="e.g. Only the owner who booked a walk can cancel it" />
          </label>
          <fieldset>
            <legend className="small">It belongs in</legend>
            {(['decision', 'domain_rule', 'constraint'] as const).map((t) => (
              <label key={t} className="inline">
                <input type="radio" name="target" checked={target === t} onChange={() => setTarget(t)} /> {targetLabel(t)}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || !text.trim()}>
            Answer with this rule
          </button>
        </form>
      )}
    </section>
  );
}
